import { Role } from '@aquaculture/backend-common/decorators';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ALERT_RECIPIENT_RESULT_MAX_USER_IDS,
  type AlertRecipientQuery,
  type AlertRecipientResult,
  type AlertRecipientRole,
} from '@platform/event-contracts';
import { In, Repository } from 'typeorm';

import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';

import { isEffectiveUserSiteAssignmentAt } from './user-site-assignment-reader';

/**
 * Contract role code → auth `users.role`. A `Record` over the contract union:
 * a role added to the contract without a mapping here is a compile error.
 */
const ROLE_OF: Record<AlertRecipientRole, Role> = {
  TENANT_ADMIN: Role.TENANT_ADMIN,
  MODULE_MANAGER: Role.MODULE_MANAGER,
  MODULE_USER: Role.MODULE_USER,
};

/**
 * Expands an escalated alarm's targets into the tenant's user ids
 * (ALERT-CRITICAL-004).
 *
 * WHY here: auth-service owns users, roles and site assignments. The alarm
 * policy names roles ("site managers + tenant admins"); who holds them changes
 * as staff change, so they are resolved at delivery time by the owner instead
 * of being frozen into the policy or copied into another service.
 *
 * WHAT (every clause tenant-scoped, ACTIVE users only):
 *   - tenantWideRoles → every active holder of the role in the tenant;
 *   - siteRoles + siteId → holders with an EFFECTIVE assignment to that site
 *     (the same `isEffectiveUserSiteAssignmentAt` predicate JWT minting uses);
 *   - siteRoles + no site → widen to tenant-wide (a missing site must never
 *     silence an alarm);
 *   - explicit userIds → only those that are active members of the tenant
 *     (another tenant's id is dropped exactly like an unknown one).
 * The answer is ids only, sorted and capped — no PII leaves through here.
 */
@Injectable()
export class AlertRecipientDirectoryService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserSiteAssignment)
    private readonly siteAssignmentRepository: Repository<UserSiteAssignment>,
  ) {}

  async resolve(
    tenantId: string,
    query: AlertRecipientQuery,
    at: Date = new Date(),
  ): Promise<AlertRecipientResult> {
    const recipients = new Set<string>();

    const tenantWideRoles =
      query.siteId === null
        ? [...query.tenantWideRoles, ...query.siteRoles]
        : query.tenantWideRoles;
    for (const id of await this.activeHolders(tenantId, tenantWideRoles)) recipients.add(id);

    if (query.siteId !== null && query.siteRoles.length > 0) {
      for (const id of await this.assignedHolders(tenantId, query.siteRoles, query.siteId, at)) {
        recipients.add(id);
      }
    }

    if (query.userIds.length > 0) {
      const members = await this.userRepository.find({
        select: ['id'],
        where: { tenantId, isActive: true, id: In(query.userIds) },
      });
      for (const member of members) recipients.add(member.id);
    }

    const sorted = Array.from(recipients).sort();
    return {
      userIds: sorted.slice(0, ALERT_RECIPIENT_RESULT_MAX_USER_IDS),
      truncated: sorted.length > ALERT_RECIPIENT_RESULT_MAX_USER_IDS,
    };
  }

  private async activeHolders(tenantId: string, roles: AlertRecipientRole[]): Promise<string[]> {
    if (roles.length === 0) return [];
    const users = await this.userRepository.find({
      select: ['id'],
      where: {
        tenantId,
        isActive: true,
        role: In(Array.from(new Set(roles.map((role) => ROLE_OF[role])))),
      },
    });
    return users.map((user) => user.id);
  }

  private async assignedHolders(
    tenantId: string,
    roles: AlertRecipientRole[],
    siteId: string,
    at: Date,
  ): Promise<string[]> {
    const holders = await this.activeHolders(tenantId, roles);
    if (holders.length === 0) return [];
    const assignments = await this.siteAssignmentRepository.find({
      where: { tenantId, siteId, isActive: true, userId: In(holders) },
    });
    return assignments
      .filter((assignment) => isEffectiveUserSiteAssignmentAt(assignment, at))
      .map((assignment) => assignment.userId);
  }
}
