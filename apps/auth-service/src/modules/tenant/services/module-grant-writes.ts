/**
 * The one way a module-access writer changes a member's grant in one module (PKG-06).
 *
 * WHY: setUserModuleAccess, Assign Manager and Remove Manager each change grants, and each change
 * must be measured the same way: whether the live grant a token would carry moved. That decides
 * whose tokens are invalidated and what the audit row records, so the write and the measure live
 * in one place.
 *
 * WHAT: a target is the grant the member should hold — a module role and whether it is the
 * module's primary manager grant — or null for none. `writeGrant` inserts, updates or
 * deactivates the member's one row in the module (UQ_user_module) to match, clears an expiry so
 * the grant is live, and returns the change of the live role (null when it did not move). A
 * primary grant is always a manager grant: a writer that lowers or removes it removes the
 * designation with it.
 *
 * RLS: user_module_assignments carries the forced tenant-isolation policy, and the writers run on
 * a transaction their caller opened and bound (ModuleAccessService). `writeGrant` reads the
 * binding back before it writes (assertTenantRlsBound) and refuses a transaction that is not
 * bound to the tenant it writes for; it never re-binds one, since a write for tenant B inside
 * tenant A's transaction is the defect to refuse.
 */
import { assertTenantRlsBound, tenantManagerRepo } from '@aquaculture/backend-common/database';
import type { ModuleRole, OwnerModuleCode } from '@aquaculture/shared-contracts';
import type { EntityManager } from 'typeorm';

import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';

export type GrantTarget = {
  readonly role: ModuleRole;
  readonly isPrimaryManager: boolean;
} | null;

/** A member's live grant in one module that a write moved. */
export interface GrantChange {
  readonly userId: string;
  readonly moduleCode: OwnerModuleCode;
  readonly from: ModuleRole | null;
  readonly to: ModuleRole | null;
}

/** The role a row grants now: active, not expired, with a role; otherwise none. */
export function liveRoleOf(row: UserModuleAssignment | undefined, now: Date): ModuleRole | null {
  if (row === undefined || !row.isActive || row.role === null) return null;
  if (row.expiresAt !== undefined && row.expiresAt !== null && row.expiresAt < now) return null;
  return row.role;
}

export interface GrantWrite {
  readonly userId: string;
  readonly moduleId: string;
  readonly moduleCode: OwnerModuleCode;
  /** The member's row in the module, as read in the writer's transaction. */
  readonly row: UserModuleAssignment | undefined;
  readonly target: GrantTarget;
  readonly assignedBy: string;
  /** The note a row this write inserts carries. */
  readonly note: string | null;
}

export async function writeGrant(
  manager: EntityManager,
  tenantId: string,
  write: GrantWrite,
  now: Date,
): Promise<GrantChange | null> {
  await assertTenantRlsBound(manager, tenantId, 'auth');
  const assignments = tenantManagerRepo(manager, UserModuleAssignment, tenantId);
  const { row, target } = write;
  const from = liveRoleOf(row, now);
  if (target === null) {
    if (row !== undefined && (row.isActive || row.isPrimaryManager)) {
      await assignments.update({ id: row.id }, { isActive: false, isPrimaryManager: false });
    }
  } else if (row === undefined) {
    await assignments.save(
      assignments.create({
        userId: write.userId,
        moduleId: write.moduleId,
        role: target.role,
        isPrimaryManager: target.isPrimaryManager,
        isActive: true,
        assignedBy: write.assignedBy,
        notes: write.note,
      }),
    );
  } else if (
    from !== target.role ||
    row.isPrimaryManager !== target.isPrimaryManager ||
    !row.isActive
  ) {
    await assignments.update(
      { id: row.id },
      {
        role: target.role,
        isPrimaryManager: target.isPrimaryManager,
        isActive: true,
        expiresAt: null,
      },
    );
  }
  const to = target === null ? null : target.role;
  return from === to ? null : { userId: write.userId, moduleCode: write.moduleCode, from, to };
}
