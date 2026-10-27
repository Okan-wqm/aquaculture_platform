/**
 * Each enabled owner module's designated managers, as the console shows them (PKG-06;
 * RBAC-MEDIUM-036; ADR-051 §5: the web stops reading tenant_modules.managerId in R3 and shows
 * the primary manager instead).
 *
 * WHY: the console read the designation from tenant_modules.managerId, which no token reads, so
 * it could name a manager who held no manager grant. A designated manager is listed here only
 * while their designation is backed by a live MODULE_MANAGER grant in the module — the fact the
 * token carries. A designation without one (an hr managerId the R1 backfill gave no hr grant,
 * D6) manages nothing and is not shown as a manager.
 *
 * WHAT: for every enabled owner module, in the dictionary's order, the members
 * designatedManagerIds names whose row in the module grants MODULE_MANAGER now.
 */
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { PLATFORM_ROLE, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import type { EntityManager } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';

import { enabledOwnerTenantModules } from './member-grants-replace';
import { liveRoleOf } from './module-grant-writes';
import { designatedManagerIds, type ModuleManagerStores } from './module-manager-designation';

export interface ModuleManagerListing {
  readonly moduleCode: OwnerModuleCode;
  readonly userId: string;
}

export async function listModuleManagers(
  manager: EntityManager,
  stores: ModuleManagerStores,
  tenantId: string,
  now: Date,
): Promise<ModuleManagerListing[]> {
  const assignments = tenantManagerRepo(manager, UserModuleAssignment, tenantId);
  const listing: ModuleManagerListing[] = [];
  for (const [moduleCode, tenantModule] of await enabledOwnerTenantModules(
    manager,
    stores,
    tenantId,
    'read',
  )) {
    for (const userId of await designatedManagerIds(manager, tenantModule)) {
      const row = await assignments.findOne({ where: { userId, moduleId: tenantModule.moduleId } });
      if (liveRoleOf(row === null ? undefined : row, now) === PLATFORM_ROLE.MODULE_MANAGER) {
        listing.push({ moduleCode, userId });
      }
    }
  }
  return listing;
}
