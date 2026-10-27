/**
 * The admin path of module access (PKG-06; RBAC-HIGH-034, RBAC-HIGH-035, RBAC-MEDIUM-036;
 * ADR-051 §2 "Change").
 *
 * WHY: a member's role in one module could only be set through the tenant-wide users.role or
 * the Assign Manager designation, which promoted users.role; a grant change revoked no session
 * and left no audit row; and the designation lived in two copies no reader joined.
 *
 * WHAT: every write opens one transaction bound to the caller's tenant (RLS), writes the grants
 * (member-grants-replace.ts, module-manager-designation.ts), enqueues the durable access-token
 * invalidation of every member whose live grant moved and writes the audit row — all or nothing
 * — and cuts the live tokens after commit. A write that moves nothing invalidates and audits
 * nothing. Nothing here writes users.role. The reads answer what a member's next token carries
 * and who each module's primary manager is.
 */
import { bindTenantRlsContext } from '@aquaculture/backend-common/database';
import type { ModuleAccess, PlatformModuleCode } from '@aquaculture/shared-contracts';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../../authentication/entities/user.entity';
import {
  DurableUserTokenInvalidationService,
  type UserTokenInvalidationIntent,
} from '../../authentication/services/durable-user-token-invalidation.service';
import { readModuleAccess } from '../../authentication/services/module-access-reader';
import { TenantModule } from '../entities/tenant-module.entity';

import { replaceMemberGrants, type ModuleAccessChoice } from './member-grants-replace';
import {
  applyModuleAccessInvalidations,
  enqueueModuleAccessInvalidations,
} from './module-access-invalidation';
import type { GrantChange } from './module-grant-writes';
import {
  clearModuleManager,
  designateModuleManager,
  type DesignationResult,
  type ModuleManagerStores,
  type ModuleRef,
} from './module-manager-designation';
import { listModuleManagers, type ModuleManagerListing } from './module-manager-listing';

/** The administrator acting, in their own tenant (from the verified claim). */
export interface ModuleAccessActor {
  readonly tenantId: string;
  readonly userId: string;
}

export interface UserModuleAccessView {
  readonly userId: string;
  readonly moduleAccess: ModuleAccess;
}

export type ModulePrimaryManagerView = ModuleManagerListing;

@Injectable()
export class ModuleAccessService {
  private readonly logger = new Logger(ModuleAccessService.name);

  constructor(
    @InjectRepository(TenantModule)
    private readonly tenantModuleRepository: Repository<TenantModule>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly durableUserTokenInvalidation: DurableUserTokenInvalidationService,
  ) {}

  async setUserModuleAccess(
    actor: ModuleAccessActor,
    input: { readonly userId: string; readonly moduleAccess: ModuleAccessChoice },
  ): Promise<UserModuleAccessView> {
    const now = new Date();
    const { view, intents } = await this.inTenant(actor.tenantId, async (manager) => {
      const replaced = await replaceMemberGrants(
        manager,
        this.stores,
        {
          tenantId: actor.tenantId,
          userId: input.userId,
          choice: input.moduleAccess,
          assignedBy: actor.userId,
        },
        now,
      );
      const result: UserModuleAccessView = { userId: input.userId, moduleAccess: replaced.after };
      if (replaced.changes.length === 0 && replaced.designationsEnded.length === 0) {
        return { view: result, intents: [] };
      }
      // Only a moved live grant changes what a token carries; an ended designation is audited.
      const enqueued =
        replaced.changes.length === 0 ? [] : await this.invalidate(manager, [replaced.member], now);
      await this.auditLogService.log(
        {
          tenantId: actor.tenantId,
          performedBy: actor.userId,
          action: 'USER_MODULE_ACCESS_SET',
          entityType: 'UserModuleAccess',
          entityId: input.userId,
          previousValue: { moduleAccess: replaced.before },
          newValue: { moduleAccess: replaced.after },
          details: { changes: replaced.changes, designationsEnded: replaced.designationsEnded },
        },
        manager,
      );
      return { view: result, intents: enqueued };
    });
    await applyModuleAccessInvalidations(this.durableUserTokenInvalidation, intents, this.logger);
    return view;
  }

  async assignModuleManager(
    actor: ModuleAccessActor,
    input: { readonly module: ModuleRef; readonly userId: string },
  ): Promise<TenantModule> {
    const now = new Date();
    const { tenantModule, intents } = await this.inTenant(actor.tenantId, async (manager) => {
      const designation = await designateModuleManager(
        manager,
        this.stores,
        {
          tenantId: actor.tenantId,
          module: input.module,
          userId: input.userId,
          assignedBy: actor.userId,
        },
        now,
      );
      const alreadyTheManager =
        designation.previousManagerIds.length === 1 &&
        designation.previousManagerIds[0] === input.userId;
      if (alreadyTheManager && designation.changes.length === 0) {
        return { tenantModule: designation.tenantModule, intents: [] };
      }
      const enqueued = await this.invalidateChanged(manager, designation, now);
      await this.auditDesignation(manager, actor, designation, 'MODULE_MANAGER_ASSIGNED', {
        moduleCode: designation.moduleCode,
        managerId: input.userId,
      });
      return { tenantModule: designation.tenantModule, intents: enqueued };
    });
    await applyModuleAccessInvalidations(this.durableUserTokenInvalidation, intents, this.logger);
    return tenantModule;
  }

  async removeModuleManager(
    actor: ModuleAccessActor,
    input: { readonly module: ModuleRef },
  ): Promise<TenantModule> {
    const now = new Date();
    const { tenantModule, intents } = await this.inTenant(actor.tenantId, async (manager) => {
      const designation = await clearModuleManager(
        manager,
        this.stores,
        { tenantId: actor.tenantId, module: input.module, assignedBy: actor.userId },
        now,
      );
      if (designation.previousManagerIds.length === 0) {
        return { tenantModule: designation.tenantModule, intents: [] };
      }
      const enqueued = await this.invalidateChanged(manager, designation, now);
      await this.auditDesignation(manager, actor, designation, 'MODULE_MANAGER_REMOVED', {
        moduleCode: designation.moduleCode,
        managerId: null,
      });
      return { tenantModule: designation.tenantModule, intents: enqueued };
    });
    await applyModuleAccessInvalidations(this.durableUserTokenInvalidation, intents, this.logger);
    return tenantModule;
  }

  /** What the member's next token carries: their grants in the enabled modules. */
  readUserModuleAccess(tenantId: string, userId: string): Promise<UserModuleAccessView> {
    return this.inTenant(tenantId, async (manager) => {
      const member = await manager
        .withRepository(this.userRepository)
        .findOne({ where: { id: userId, tenantId } });
      if (member === null) throw new NotFoundException('User not found in this tenant');
      const read = await readModuleAccess(
        (sql, parameters) => manager.query(sql, [...parameters]),
        { id: member.id, role: member.role, tenantId },
      );
      return { userId, moduleAccess: read.moduleAccess };
    });
  }

  /** Each enabled owner module's designated managers who hold its manager grant. */
  listPrimaryManagers(tenantId: string): Promise<ModulePrimaryManagerView[]> {
    return this.inTenant(tenantId, (manager) =>
      listModuleManagers(manager, this.stores, tenantId, new Date()),
    );
  }

  private get stores(): ModuleManagerStores {
    return { tenantModules: this.tenantModuleRepository, users: this.userRepository };
  }

  private inTenant<T>(tenantId: string, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await bindTenantRlsContext(manager, tenantId, 'auth');
      return work(manager);
    });
  }

  private invalidate(
    manager: EntityManager,
    members: readonly User[],
    now: Date,
  ): Promise<UserTokenInvalidationIntent[]> {
    return enqueueModuleAccessInvalidations(
      manager,
      this.durableUserTokenInvalidation,
      members,
      'module-access-changed',
      now,
    );
  }

  /** The members whose live grant the designation moved. */
  private invalidateChanged(
    manager: EntityManager,
    designation: DesignationResult,
    now: Date,
  ): Promise<UserTokenInvalidationIntent[]> {
    const moved = new Set(designation.changes.map((change: GrantChange) => change.userId));
    const members = [...designation.members.values()].filter((member) => moved.has(member.id));
    return this.invalidate(manager, members, now);
  }

  private async auditDesignation(
    manager: EntityManager,
    actor: ModuleAccessActor,
    designation: DesignationResult,
    action: 'MODULE_MANAGER_ASSIGNED' | 'MODULE_MANAGER_REMOVED',
    newValue: { readonly moduleCode: PlatformModuleCode; readonly managerId: string | null },
  ): Promise<void> {
    await this.auditLogService.log(
      {
        tenantId: actor.tenantId,
        performedBy: actor.userId,
        action,
        entityType: 'TenantModule',
        entityId: designation.tenantModule.id,
        previousValue: {
          moduleCode: designation.moduleCode,
          managerIds: designation.previousManagerIds,
        },
        newValue,
        details: { changes: designation.changes },
      },
      manager,
    );
  }
}
