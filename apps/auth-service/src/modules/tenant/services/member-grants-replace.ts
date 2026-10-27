/**
 * setUserModuleAccess's write: a member's whole set of module roles, replaced (PKG-06; ADR-051
 * §2 "Change").
 *
 * WHY: an admin had no way to give a member a role in one module: the only levels were the
 * tenant-wide users.role and the Assign Manager designation. A declarative replace states the
 * member's grants once and leaves no partial edit to reason about.
 *
 * WHAT: inside the caller's transaction (tenant bound): the tenant's enabled modules are locked
 * in module-id order, then the member (their credential lock, as token mint takes). A role named
 * for a module the tenant has not enabled is refused before anything is written; the rows of a
 * module that is not enabled are left alone, since the claim never carries them. Every enabled
 * owner module gets the stated role or none (writeGrant). A primary manager grant stays primary
 * only while it stays a manager grant; lowering or removing it ends the designation, and the
 * legacy tenant_modules.managerId mirror goes when the member's manager grant goes. Every
 * designation that ended is reported, for the audit row. A tenant administrator holds every
 * enabled module through the account role, so module roles are set for members only.
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  OWNER_MODULE_CODES,
  PLATFORM_ROLE,
  type ModuleAccess,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import type { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import type { TenantModule } from '../entities/tenant-module.entity';

import type { ModuleManagerStores } from './module-manager-designation';
import { liveRoleOf, writeGrant, type GrantChange } from './module-grant-writes';
import { lockUserForCredentialMutation } from './user-credential-revocation';

/** The member's module roles as stated: a role per owner module, absent or null for none. */
export type ModuleAccessChoice = { readonly [Code in OwnerModuleCode]?: ModuleRole | null };

export interface MemberGrantsReplaced {
  readonly member: User;
  /** The member's grants in the enabled modules before and after, in the claim's shape. */
  readonly before: ModuleAccess;
  readonly after: ModuleAccess;
  readonly changes: readonly GrantChange[];
  /**
   * The modules whose manager designation named the member and no longer does: a primary
   * manager grant lowered or removed, or the legacy managerId copy cleared with it.
   */
  readonly designationsEnded: readonly OwnerModuleCode[];
}

export async function replaceMemberGrants(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly choice: ModuleAccessChoice;
    readonly assignedBy: string;
  },
  now: Date,
): Promise<MemberGrantsReplaced> {
  const enabled = await enabledOwnerTenantModules(manager, stores, input.tenantId, 'lock');
  for (const code of OWNER_MODULE_CODES) {
    const role = input.choice[code];
    if (role !== undefined && role !== null && !enabled.has(code)) {
      throw new BadRequestException(`Module "${code}" is not enabled for this tenant`);
    }
  }
  const member = await lockUserForCredentialMutation(
    manager,
    stores.users,
    input.userId,
    input.tenantId,
  );
  if (member === null) throw new NotFoundException('User not found in this tenant');
  if (member.role === Role.TENANT_ADMIN || member.role === Role.SUPER_ADMIN) {
    throw new BadRequestException(
      'An administrator holds every enabled module; module roles are set for members',
    );
  }

  const assignments = tenantManagerRepo(manager, UserModuleAssignment, input.tenantId);
  const rows = new Map(
    (await assignments.find({ where: { userId: input.userId } })).map((row) => [row.moduleId, row]),
  );
  const before: { [Code in OwnerModuleCode]?: ModuleRole } = {};
  const after: { [Code in OwnerModuleCode]?: ModuleRole } = {};
  const changes: GrantChange[] = [];
  const designationsEnded: OwnerModuleCode[] = [];
  for (const [code, tenantModule] of enabled) {
    const row = rows.get(tenantModule.moduleId);
    const held = liveRoleOf(row, now);
    if (held !== null) before[code] = held;
    const role = input.choice[code] ?? null;
    if (role !== null) after[code] = role;
    const staysPrimary =
      row !== undefined &&
      row.isPrimaryManager &&
      held !== null &&
      role === PLATFORM_ROLE.MODULE_MANAGER;
    const wasDesignated =
      (row !== undefined && row.isPrimaryManager) || tenantModule.managerId === input.userId;
    const change = await writeGrant(
      assignments,
      {
        userId: input.userId,
        moduleId: tenantModule.moduleId,
        moduleCode: code,
        row,
        target: role === null ? null : { role, isPrimaryManager: staysPrimary },
        assignedBy: input.assignedBy,
        note: null,
      },
      now,
    );
    if (change !== null) changes.push(change);
    // The legacy designation copy follows the grant: it goes when the manager grant goes.
    const keepsManagerId =
      role === PLATFORM_ROLE.MODULE_MANAGER && tenantModule.managerId === input.userId;
    if (!keepsManagerId && tenantModule.managerId === input.userId) {
      tenantModule.managerId = null;
      await manager.withRepository(stores.tenantModules).save(tenantModule);
    }
    if (wasDesignated && !staysPrimary && !keepsManagerId) designationsEnded.push(code);
  }
  return { member, before, after, changes, designationsEnded };
}

/**
 * The tenant's enabled owner modules, by code in the dictionary's order. A writer locks their
 * tenant modules (in id order, so two writers cannot deadlock); a reader does not.
 */
export async function enabledOwnerTenantModules(
  manager: EntityManager,
  stores: ModuleManagerStores,
  tenantId: string,
  mode: 'lock' | 'read',
): Promise<Map<OwnerModuleCode, TenantModule>> {
  const catalogue = await manager.find(Module, { select: { id: true, code: true } });
  const codeById = new Map(catalogue.map((module) => [module.id, module.code]));
  const tenantModules = await manager.withRepository(stores.tenantModules).find({
    where: { tenantId, isEnabled: true },
    order: { moduleId: 'ASC' },
    ...(mode === 'lock' ? { lock: { mode: 'pessimistic_write' as const } } : {}),
  });
  const enabled = new Map<OwnerModuleCode, TenantModule>();
  for (const code of OWNER_MODULE_CODES) {
    const tenantModule = tenantModules.find((row) => codeById.get(row.moduleId) === code);
    if (tenantModule !== undefined) enabled.set(code, tenantModule);
  }
  return enabled;
}
