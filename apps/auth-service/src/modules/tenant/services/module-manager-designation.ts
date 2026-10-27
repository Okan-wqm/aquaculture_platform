/**
 * Assign Manager and Remove Manager: a module's primary manager, held as a grant (PKG-06;
 * RBAC-HIGH-034, RBAC-MEDIUM-036; ADR-051 §2 "Change").
 *
 * WHY: a module's manager was stored twice and the copies never met — Assign Manager wrote
 * tenant_modules.managerId, which no token read, and promoted users.role tenant-wide, which made
 * the manager of one module a manager of every module, HR payroll included; Remove Manager
 * reverted neither. Release R1 bolted a grant onto the designation and re-derived it from both
 * copies. The designation is now one fact in the store the token reads: the module's primary
 * manager grant (isPrimaryManager, role MODULE_MANAGER) in user_module_assignments. users.role is
 * an account role and is never written here.
 *
 * WHAT: both run inside the caller's transaction, which binds the tenant (RLS); they read the
 * binding back first (assertTenantRlsBound) and never re-bind it. They resolve the
 * module by its code, or by the module id the release-R2 web still sends, and only an owner
 * module is designated (alert and ai own no data and carry no grant); Assign Manager also needs
 * it enabled. They lock the tenant module first, then the members whose grants change in
 * ascending id order (their credential locks, as token mint takes), so two designations that
 * swap managers cannot deadlock and a mint never reads a half-written designation.
 *   - Assign Manager gives the designee the module's primary manager grant (inserted, raised or
 *     reactivated) — in hr as in every owner module: it is the per-module manager choice D6
 *     admits — and takes every previous designation back to a user grant: the rows marked
 *     primary and the legacy managerId designee.
 *   - Remove Manager takes every designation back the same way.
 * tenant_modules.managerId is still mapped until PKG-06 PR2 unmaps it (C4), so it is written in
 * the same transaction as the grant it mirrors and nothing decides by it; the R3 backfill re-run
 * that PR carries reads it consistently.
 */
import {
  assertTenantRlsBound,
  tenantManagerRepo,
  type TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import {
  isOwnerModuleCode,
  PLATFORM_ROLE,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager, Repository } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import type { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import type { TenantModule } from '../entities/tenant-module.entity';

import { liveRoleOf, writeGrant, type GrantChange } from './module-grant-writes';
import { lockUserForCredentialMutation } from './user-credential-revocation';

/** The repositories a designation writes through; the caller's transaction binds them. */
export interface ModuleManagerStores {
  readonly tenantModules: Repository<TenantModule>;
  readonly users: Repository<User>;
}

/** A module, named by its code or, for the release-R2 web, by its catalogue id. */
export type ModuleRef = { readonly moduleCode: string } | { readonly moduleId: string };

/** The module an Assign / Remove Manager request names: its code or its id, exactly one. */
export function moduleRefOf(input: {
  readonly moduleCode?: string | null;
  readonly moduleId?: string | null;
}): ModuleRef {
  const { moduleCode, moduleId } = input;
  if (moduleCode !== undefined && moduleCode !== null) {
    if (moduleId !== undefined && moduleId !== null) {
      throw new BadRequestException('Name the module by its code or by its id, not both');
    }
    return { moduleCode };
  }
  if (moduleId !== undefined && moduleId !== null) return { moduleId };
  throw new BadRequestException('Name the module by its code');
}

export interface DesignationResult {
  readonly tenantModule: TenantModule;
  readonly moduleCode: OwnerModuleCode;
  /** The live grants the designation moved. */
  readonly changes: readonly GrantChange[];
  /** The locked members, by id: the designee and every previous designation. */
  readonly members: ReadonlyMap<string, User>;
  /** Who held the designation before (primary rows and the legacy managerId). */
  readonly previousManagerIds: readonly string[];
}

/** The note on a row Assign Manager inserts, as the backfill notes the rows it inserts. */
export const DESIGNATED_MANAGER_ROW_NOTE = 'Inserted by Assign Manager (tenant_modules.managerId)';

export async function designateModuleManager(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: {
    readonly tenantId: string;
    readonly module: ModuleRef;
    readonly userId: string;
    readonly assignedBy: string;
  },
  now: Date,
): Promise<DesignationResult> {
  await assertTenantRlsBound(manager, input.tenantId, 'auth');
  const { tenantModule, moduleCode } = await lockOwnerTenantModule(manager, stores, input);
  if (!tenantModule.isEnabled) {
    throw new BadRequestException(`Module "${moduleCode}" is not enabled for this tenant`);
  }
  const previous = await designatedManagerIds(manager, tenantModule);
  const members = await lockMembers(manager, stores, input.tenantId, [input.userId, ...previous]);
  if (!members.has(input.userId)) {
    throw new NotFoundException('User not found in this tenant');
  }

  const assignments = tenantManagerRepo(manager, UserModuleAssignment, input.tenantId);
  const changes: GrantChange[] = [];
  for (const userId of previous.filter((id) => id !== input.userId && members.has(id))) {
    const change = await retireDesignation(
      manager,
      assignments,
      tenantModule,
      moduleCode,
      userId,
      input,
      now,
    );
    if (change !== null) changes.push(change);
  }
  const designeeChange = await writeGrant(
    manager,
    input.tenantId,
    {
      userId: input.userId,
      moduleId: tenantModule.moduleId,
      moduleCode,
      row: await rowOf(assignments, input.userId, tenantModule.moduleId),
      target: { role: PLATFORM_ROLE.MODULE_MANAGER, isPrimaryManager: true },
      assignedBy: input.assignedBy,
      note: DESIGNATED_MANAGER_ROW_NOTE,
    },
    now,
  );
  if (designeeChange !== null) changes.push(designeeChange);

  tenantModule.managerId = input.userId;
  const saved = await manager.withRepository(stores.tenantModules).save(tenantModule);
  return { tenantModule: saved, moduleCode, changes, members, previousManagerIds: previous };
}

export async function clearModuleManager(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: { readonly tenantId: string; readonly module: ModuleRef; readonly assignedBy: string },
  now: Date,
): Promise<DesignationResult> {
  await assertTenantRlsBound(manager, input.tenantId, 'auth');
  const { tenantModule, moduleCode } = await lockOwnerTenantModule(manager, stores, input);
  const previous = await designatedManagerIds(manager, tenantModule);
  const members = await lockMembers(manager, stores, input.tenantId, previous);

  const assignments = tenantManagerRepo(manager, UserModuleAssignment, input.tenantId);
  const changes: GrantChange[] = [];
  for (const userId of previous.filter((id) => members.has(id))) {
    const change = await retireDesignation(
      manager,
      assignments,
      tenantModule,
      moduleCode,
      userId,
      input,
      now,
    );
    if (change !== null) changes.push(change);
  }
  let saved = tenantModule;
  if (tenantModule.managerId !== null && tenantModule.managerId !== undefined) {
    tenantModule.managerId = null;
    saved = await manager.withRepository(stores.tenantModules).save(tenantModule);
  }
  return { tenantModule: saved, moduleCode, changes, members, previousManagerIds: previous };
}

/** The tenant module of an owner module, under a write lock. */
async function lockOwnerTenantModule(
  manager: EntityManager,
  stores: ModuleManagerStores,
  input: { readonly tenantId: string; readonly module: ModuleRef },
): Promise<{ tenantModule: TenantModule; moduleCode: OwnerModuleCode }> {
  const catalogue = await manager.find(Module, { select: { id: true, code: true } });
  let named: Module | undefined;
  if ('moduleCode' in input.module) {
    const { moduleCode } = input.module;
    named = catalogue.find((module) => module.code === moduleCode);
    if (named === undefined) throw new BadRequestException(`"${moduleCode}" is no module`);
  } else {
    const { moduleId } = input.module;
    named = catalogue.find((module) => module.id === moduleId);
    if (named === undefined) throw new NotFoundException('Module not assigned to this tenant');
  }
  const { code } = named;
  if (!isOwnerModuleCode(code)) {
    throw new BadRequestException(`Module "${code}" owns no data and has no manager`);
  }
  const tenantModule = await manager.withRepository(stores.tenantModules).findOne({
    where: { tenantId: input.tenantId, moduleId: named.id },
    lock: { mode: 'pessimistic_write' },
  });
  if (tenantModule === null) throw new NotFoundException('Module not assigned to this tenant');
  return { tenantModule, moduleCode: code };
}

/**
 * Every member the module's designation names, live or not: the rows marked primary and the
 * legacy managerId. Until PKG-06 PR2 folds managerId into the primary rows and unmaps it (C4),
 * a designation an Assign Manager of an earlier release wrote lives only in managerId, so both
 * are read here, the one reader of "who is designated".
 */
export async function designatedManagerIds(
  manager: EntityManager,
  tenantModule: TenantModule,
): Promise<string[]> {
  const primaries = await tenantManagerRepo(
    manager,
    UserModuleAssignment,
    tenantModule.tenantId,
  ).find({ where: { moduleId: tenantModule.moduleId, isPrimaryManager: true } });
  const ids = primaries.map((row) => row.userId);
  if (tenantModule.managerId !== null && tenantModule.managerId !== undefined) {
    ids.push(tenantModule.managerId);
  }
  return [...new Set(ids)];
}

/** The tenant's members among `ids`, credential-locked in ascending id order. */
async function lockMembers(
  manager: EntityManager,
  stores: ModuleManagerStores,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, User>> {
  const members = new Map<string, User>();
  for (const id of [...new Set(ids)].sort()) {
    const member = await lockUserForCredentialMutation(manager, stores.users, id, tenantId);
    if (member !== null) members.set(id, member);
  }
  return members;
}

async function rowOf(
  assignments: TenantScopedRepository<UserModuleAssignment>,
  userId: string,
  moduleId: string,
): Promise<UserModuleAssignment | undefined> {
  const row = await assignments.findOne({ where: { userId, moduleId } });
  return row === null ? undefined : row;
}

/** A previous designation: a live grant goes back to a user grant, the designation goes. */
async function retireDesignation(
  manager: EntityManager,
  assignments: TenantScopedRepository<UserModuleAssignment>,
  tenantModule: TenantModule,
  moduleCode: OwnerModuleCode,
  userId: string,
  input: { readonly assignedBy: string },
  now: Date,
): Promise<GrantChange | null> {
  const row = await rowOf(assignments, userId, tenantModule.moduleId);
  if (row === undefined) return null;
  return writeGrant(
    manager,
    tenantModule.tenantId,
    {
      userId,
      moduleId: tenantModule.moduleId,
      moduleCode,
      row,
      target:
        liveRoleOf(row, now) === null
          ? null
          : { role: PLATFORM_ROLE.MODULE_USER, isPrimaryManager: false },
      assignedBy: input.assignedBy,
      note: null,
    },
    now,
  );
}
