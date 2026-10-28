/**
 * Re-derives the roles of a member's module grants after an input of the rule changed
 * (RBAC-HIGH-027; ADR-051 §2 "Backfill").
 *
 * WHY: the role of a grant is derived from inputs that live outside the row — users.role and
 * tenant_modules.managerId — and from its own isPrimaryManager (assignment-module-role.ts). A
 * writer that changed one of them without touching the rows left the role stale: a member
 * designated farm manager after R1 kept the MODULE_USER the backfill gave their farm row, and
 * farm decides by that row from R4, so the designated manager would be locked out. The backfill
 * cannot repair it: it fills only rows without a role.
 *
 * WHAT: `rederiveModuleGrantRoles` applies moduleAssignmentGrant to every grant the member holds
 * in the tenant, with the inputs as they stand in the caller's transaction, and writes the roles
 * that differ. Every writer of an input calls it in the transaction that writes the input, after
 * the write (Assign and Remove Manager, the admin role edit), so the role never outlives its
 * inputs. The caller holds the member's credential lock (lockUserForCredentialMutation), which
 * serialises it with token mint and with the other writers of users.role.
 *
 * RLS: user_module_assignments and tenant_modules carry the forced tenant-isolation policy, and
 * the admin role edit arrives over NATS with no tenant bound, where every read here would see no
 * row and the re-derivation would silently do nothing. The rows read and written belong to the
 * member's tenant only, so it binds the transaction to that tenant first (bindTenantRlsContext:
 * transaction-local, read back, fail-closed). The binding lasts until the transaction ends, so a
 * caller re-derives after its other writes and writes nothing for another tenant afterwards.
 */
import { bindTenantRlsContext, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import type { ModuleRole } from '@aquaculture/shared-contracts';
import type { EntityManager } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { moduleAssignmentGrant } from '../../authentication/services/assignment-module-role';
import { TenantModule } from '../entities/tenant-module.entity';

/** One grant whose role a re-derivation changed. */
export interface ModuleGrantRoleChange {
  readonly moduleId: string;
  readonly from: ModuleRole | null;
  readonly to: ModuleRole;
}

/** The member whose grants are re-derived, with users.role as the caller's transaction sees it. */
export interface ModuleGrantMember {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: Role;
}

export async function rederiveModuleGrantRoles(
  manager: EntityManager,
  member: ModuleGrantMember,
): Promise<readonly ModuleGrantRoleChange[]> {
  await bindTenantRlsContext(manager, member.tenantId, 'auth');
  const assignments = tenantManagerRepo(manager, UserModuleAssignment, member.tenantId);
  const rows = await assignments.find({
    where: { userId: member.userId },
    relations: { module: true },
  });
  if (rows.length === 0) return [];
  const designations = await tenantManagerRepo(manager, TenantModule, member.tenantId).find({
    select: { moduleId: true },
    where: { managerId: member.userId },
  });
  const designatedModuleIds = new Set(designations.map((designation) => designation.moduleId));

  const changes: ModuleGrantRoleChange[] = [];
  for (const row of rows) {
    const { role } = moduleAssignmentGrant({
      isPrimaryManager: row.isPrimaryManager,
      isDesignatedManager: designatedModuleIds.has(row.moduleId),
      userRole: member.role,
      moduleCode: row.module.code,
    });
    if (row.role === role) continue;
    await assignments.update({ id: row.id }, { role });
    changes.push({ moduleId: row.moduleId, from: row.role, to: role });
  }
  return changes;
}
