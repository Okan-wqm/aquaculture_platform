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
 *   - siteRoles + siteId → holders with an EFFECTIVE assignment to that site
 *     (the same `isEffectiveUserSiteAssignmentAt` predicate JWT minting uses);
 *     a site role with NO holder at the site widens to that role's holders
 *     tenant-wide (V-S1a-5: a site nobody manages must not silence its alarm);
 *   - siteRoles + no site → widen to tenant-wide (a missing site must never
 *     silence an alarm);
 *   - explicit userIds → only those that are active members of the tenant
 *     (another tenant's id is dropped exactly like an unknown one);
 *   - tenantWideRoles → every active holder of the role in the tenant.
 *
 * CAP ORDER (V-S1b-7): the answer is capped. Recipients are ranked by how
 * directly the alarm concerns them — the people at the incident's site first,
 * then the ids the policy names, then tenant-wide holders — so the cap cuts
 * the tenant-wide tail and the site's own managers are cut last. Within a tier
 * ids are sorted, so the answer is deterministic.
 *
 * The answer is ids only — no PII leaves through here.
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
    const siteTier: string[] = [];
    const widenedRoles: AlertRecipientRole[] = query.siteId === null ? [...query.siteRoles] : [];

    if (query.siteId !== null) {
      for (const role of new Set(query.siteRoles)) {
        const atSite = await this.assignedHolders(tenantId, [role], query.siteId, at);
        if (atSite.length > 0) siteTier.push(...atSite);
        else widenedRoles.push(role);
      }
    }

    const explicitTier =
      query.userIds.length > 0
        ? (
            await this.userRepository.find({
              select: ['id'],
              where: { tenantId, isActive: true, id: In(query.userIds) },
            })
          ).map((member) => member.id)
        : [];

    const tenantTier = await this.activeHolders(tenantId, [
      ...widenedRoles,
      ...query.tenantWideRoles,
    ]);

    const ranked: string[] = [];
    const seen = new Set<string>();
    for (const tier of [siteTier, explicitTier, tenantTier]) {
      for (const id of [...tier].sort()) {
        if (seen.has(id)) continue;
        seen.add(id);
        ranked.push(id);
      }
    }
    return {
      userIds: ranked.slice(0, ALERT_RECIPIENT_RESULT_MAX_USER_IDS),
      truncated: ranked.length > ALERT_RECIPIENT_RESULT_MAX_USER_IDS,
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
