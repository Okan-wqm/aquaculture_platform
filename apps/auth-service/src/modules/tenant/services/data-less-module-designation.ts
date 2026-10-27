/**
 * Assign / Remove Manager on a module that owns no data, named by the module id the release-R2
 * console sends (PKG-06; RBAC-HIGH-034, RBAC-HIGH-035; ADR-051 §5, C6 (b)).
 *
 * WHY: alert and ai own no data and carry no grant (ADR-051 §2: the token reader drops them), so
 * they have no primary manager grant to write. The R2 console still offers Assign Manager on
 * their cards and sends their id, and it succeeded there; refusing it now is a newly refused value
 * that a client of the previous release uses, which C6 (b) keeps out of a release with migrations
 * (R3). PKG-06 PR2 unmaps tenant_modules.managerId in R4, a release without migrations whose
 * console offers manager actions only on owner modules; the refusal ships there (ADR-051 §5
 * BREAKING table). Until then the designation of such a module is that column alone, as it was,
 * without the tenant-wide promotion of users.role (RBAC-HIGH-034). No access decision reads it,
 * so no token is invalidated; the caller audits every change (RBAC-HIGH-035).
 *
 * WHAT: the caller has bound the tenant and locked the tenant module. Assign checks the designee
 * is a member of the tenant and writes managerId; Remove clears it. A write that changes nothing
 * is not saved.
 */
import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { TenantModule } from '../entities/tenant-module.entity';

import type {
  DataLessModuleCode,
  DesignationResult,
  ModuleManagerStores,
} from './module-manager-designation';

export async function designateDataLessModule(
  manager: EntityManager,
  stores: ModuleManagerStores,
  tenantModule: TenantModule,
  moduleCode: DataLessModuleCode,
  input: { readonly tenantId: string; readonly userId: string },
): Promise<DesignationResult> {
  const designee = await manager
    .withRepository(stores.users)
    .findOne({ where: { id: input.userId, tenantId: input.tenantId } });
  if (designee === null) {
    throw new NotFoundException('User not found in this tenant');
  }
  const previous = managerIdsOf(tenantModule);
  if (tenantModule.managerId === input.userId) {
    return withoutGrants(tenantModule, moduleCode, previous);
  }
  tenantModule.managerId = input.userId;
  const saved = await manager.withRepository(stores.tenantModules).save(tenantModule);
  return withoutGrants(saved, moduleCode, previous);
}

export async function clearDataLessModule(
  manager: EntityManager,
  stores: ModuleManagerStores,
  tenantModule: TenantModule,
  moduleCode: DataLessModuleCode,
): Promise<DesignationResult> {
  const previous = managerIdsOf(tenantModule);
  if (previous.length === 0) return withoutGrants(tenantModule, moduleCode, previous);
  tenantModule.managerId = null;
  const saved = await manager.withRepository(stores.tenantModules).save(tenantModule);
  return withoutGrants(saved, moduleCode, previous);
}

function managerIdsOf(tenantModule: TenantModule): string[] {
  const { managerId } = tenantModule;
  return managerId === null || managerId === undefined ? [] : [managerId];
}

/** No grant exists for such a module, so no grant moves and no member is locked. */
function withoutGrants(
  tenantModule: TenantModule,
  moduleCode: DataLessModuleCode,
  previousManagerIds: readonly string[],
): DesignationResult {
  return { tenantModule, moduleCode, changes: [], members: new Map(), previousManagerIds };
}
