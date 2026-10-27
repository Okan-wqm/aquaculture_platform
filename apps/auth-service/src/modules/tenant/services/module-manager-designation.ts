/**
 * Assign Manager and Remove Manager, with the grants they imply, in one transaction
 * (RBAC-HIGH-027; ADR-051 §2 "Backfill").
 *
 * WHY: Assign Manager wrote tenant_modules.managerId and promoted users.role but never a grant,
 * and Remove Manager cleared managerId and left the grant alone. Both are inputs of a grant's
 * role (assignment-module-role.ts), so a manager designated after the R1 backfill kept their
 * MODULE_USER grant (or none) and was locked out of the module they manage once it decides by
 * the grant (R4), while a removed one kept whatever the designation had given them.
 *
 * WHAT: each opens one transaction bound to the tenant (bindTenantRlsContext: tenant_modules and
 * user_module_assignments carry the forced tenant-isolation policy, and the binding is read
 * back, so a connection that resolved elsewhere fails instead of writing nothing). Both lock the
 * tenant module first, then the members whose grants change in ascending id order (the designee
 * and the previous designee; their credential locks, as token mint takes), so two designations
 * that swap managers cannot deadlock and a mint never reads a half-written designation. They
 * write managerId, then:
 *   - Assign Manager gives the designee a live row in a farm, sensor or hydroponics module (a
 *     missing row is inserted as the backfill inserts it, an inactive one is reactivated as
 *     assignUserToModule reactivates it). An hr designation writes no hr grant: an hr manager
 *     grant comes only from the primary-manager choice (D6), and the caller logs the case.
 *     alert and ai own no data and carry no grant.
 *   - every member whose inputs changed has all their grants re-derived
 *     (module-grant-rederivation.ts): users.role changes every non-hr row of the designee.
 * The legacy promotion of users.role stays until PKG-06 (R3) makes Assign Manager take a module
 * code and stop writing it (ADR-051 "Implementation packages").
 */
import { bindTenantRlsContext, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { OWNER_MODULE, isOwnerModuleCode } from '@aquaculture/shared-contracts';
import { NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import type { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import type { TenantModule } from '../entities/tenant-module.entity';

import { memberModuleGrant } from './module-assignment-grants';
import { rederiveModuleGrantRoles, type ModuleGrantRoleChange } from './module-grant-rederivation';
import { lockUserForCredentialMutation } from './user-credential-revocation';

/** The repositories a designation writes through; its transaction binds them. */
export interface ModuleManagerStores {
  readonly tenantModules: Repository<TenantModule>;
  readonly users: Repository<User>;
}

export interface ModuleManagerChange {
  /** The tenant module as saved, its `module` loaded. */
  readonly tenantModule: TenantModule;
  /** Per member whose inputs changed, the grant roles the change re-derived. */
  readonly rederived: ReadonlyMap<string, readonly ModuleGrantRoleChange[]>;
  /** An hr designation: no hr manager grant was derived from it (D6). */
  readonly hrManagerGrantWithheld: boolean;
}

/** The note on a row Assign Manager inserts, as the backfill notes the rows it inserts. */
export const DESIGNATED_MANAGER_ROW_NOTE = 'Inserted by Assign Manager (tenant_modules.managerId)';

export function designateModuleManager(
  dataSource: DataSource,
  stores: ModuleManagerStores,
  input: {
    readonly tenantId: string;
    readonly moduleId: string;
    readonly userId: string;
    readonly assignedBy: string;
  },
): Promise<ModuleManagerChange> {
  return inTenantTransaction(dataSource, input.tenantId, (manager) =>
    writeDesignation(manager, stores, input),
  );
}

export function clearModuleManager(
  dataSource: DataSource,
  stores: ModuleManagerStores,
  input: { readonly tenantId: string; readonly moduleId: string },
): Promise<ModuleManagerChange> {
  return inTenantTransaction(dataSource, input.tenantId, (manager) =>
    clearDesignation(manager, stores, input),
  );
}

function inTenantTransaction<T>(
  dataSource: DataSource,
  tenantId: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await bindTenantRlsContext(manager, tenantId, 'auth');
    return work(manager);
  });
}

async function writeDesignation(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: {
    readonly tenantId: string;
    readonly moduleId: string;
    readonly userId: string;
    readonly assignedBy: string;
  },
): Promise<ModuleManagerChange> {
  const tenantModule = await lockTenantModule(manager, stores, input);
  const members = await lockMembers(manager, stores, input.tenantId, [
    input.userId,
    tenantModule.managerId ?? null,
  ]);
  const designee = members.get(input.userId);
  if (designee === undefined) {
    throw new NotFoundException('User not found in this tenant');
  }

  tenantModule.managerId = designee.id;
  const saved = await manager.withRepository(stores.tenantModules).save(tenantModule);
  // Legacy tenant-wide promotion; PKG-06 deletes it (see the file header).
  if (designee.role !== Role.TENANT_ADMIN && designee.role !== Role.SUPER_ADMIN) {
    designee.role = Role.MODULE_MANAGER;
    await manager.withRepository(stores.users).save(designee);
  }

  const { code } = saved.module;
  if (isOwnerModuleCode(code) && code !== OWNER_MODULE.HR) {
    await ensureLiveDesigneeRow(manager, saved, designee, input.assignedBy);
  }
  return {
    tenantModule: saved,
    rederived: await rederiveMembers(manager, input.tenantId, members.values()),
    hrManagerGrantWithheld: code === OWNER_MODULE.HR,
  };
}

async function clearDesignation(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: { readonly tenantId: string; readonly moduleId: string },
): Promise<ModuleManagerChange> {
  const tenantModule = await lockTenantModule(manager, stores, input);
  const members = await lockMembers(manager, stores, input.tenantId, [
    tenantModule.managerId ?? null,
  ]);

  tenantModule.managerId = null;
  const saved = await manager.withRepository(stores.tenantModules).save(tenantModule);
  return {
    tenantModule: saved,
    rederived: await rederiveMembers(manager, input.tenantId, members.values()),
    hrManagerGrantWithheld: false,
  };
}

/** The tenant module under a write lock, its catalogue module attached for the caller. */
async function lockTenantModule(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: { readonly tenantId: string; readonly moduleId: string },
): Promise<TenantModule> {
  const tenantModule = await manager.withRepository(stores.tenantModules).findOne({
    where: { tenantId: input.tenantId, moduleId: input.moduleId },
    lock: { mode: 'pessimistic_write' },
  });
  if (tenantModule === null) {
    throw new NotFoundException('Module not assigned to this tenant');
  }
  // A separate read: Postgres refuses FOR UPDATE on the outer join a relation load adds.
  tenantModule.module = await manager.findOneOrFail(Module, {
    where: { id: tenantModule.moduleId },
  });
  return tenantModule;
}

/** The tenant's members among `ids`, credential-locked in ascending id order. */
async function lockMembers(
  manager: EntityManager,
  stores: ModuleManagerStores,
  tenantId: string,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, User>> {
  const ordered = [...new Set(ids.filter((id): id is string => id !== null))].sort();
  const members = new Map<string, User>();
  for (const id of ordered) {
    const member = await lockUserForCredentialMutation(manager, stores.users, id, tenantId);
    if (member !== null) members.set(id, member);
  }
  return members;
}

async function ensureLiveDesigneeRow(
  manager: EntityManager,
  tenantModule: TenantModule,
  designee: User,
  assignedBy: string,
): Promise<void> {
  const assignments = tenantManagerRepo(manager, UserModuleAssignment, tenantModule.tenantId);
  const existing = await assignments.findOne({
    where: { userId: designee.id, moduleId: tenantModule.moduleId },
  });
  if (existing === null) {
    await assignments.save(
      assignments.create({
        userId: designee.id,
        moduleId: tenantModule.moduleId,
        ...memberModuleGrant(tenantModule, designee, false),
        isActive: true,
        assignedBy,
        notes: DESIGNATED_MANAGER_ROW_NOTE,
      }),
    );
  } else if (!existing.isActive) {
    await assignments.update({ id: existing.id }, { isActive: true });
  }
}

async function rederiveMembers(
  manager: EntityManager,
  tenantId: string,
  members: Iterable<User>,
): Promise<Map<string, readonly ModuleGrantRoleChange[]>> {
  const rederived = new Map<string, readonly ModuleGrantRoleChange[]>();
  for (const member of members) {
    rederived.set(
      member.id,
      await rederiveModuleGrantRoles(manager, {
        tenantId,
        userId: member.id,
        role: member.role,
      }),
    );
  }
  return rederived;
}
