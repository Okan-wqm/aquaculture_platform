import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { DepartmentHR } from '../entities/department.entity';

/**
 * The one rule for "may an employee be placed in this department".
 *
 * An employee's module is read through their department (`moduleCode` lives on
 * `departments_hr`), so a department that is soft-deleted, switched off, or
 * not in the tenant would leave the employee in no module or the wrong one.
 * Create and update both call this; there is no second validation path.
 *
 * "Live" here is stricter than the module view filter (`common/module-scope.ts`
 * only needs `isDeleted = false`): members of a switched-off department stay
 * listed in their module, but nobody NEW can be placed into one. An employee
 * who keeps the department they are in is never re-validated (the update
 * handler skips an unchanged id).
 *
 * Runs on the caller's transaction manager so the check and the write see the
 * same snapshot. The department row is share-locked until that transaction ends:
 * deleting a department counts its members under a write lock on the same row
 * (update-department.handler.ts), so a placement and a delete serialize instead
 * of both passing their check and leaving the employee in a deleted department.
 *
 * @throws ConflictException when no live department with that id exists in the tenant.
 */
export async function assertAssignableDepartment(
  manager: EntityManager,
  tenantId: string,
  departmentHrId: string,
): Promise<void> {
  const department = await tenantManagerRepo(manager, DepartmentHR, tenantId).findOne({
    where: { id: departmentHrId, isDeleted: false, isActive: true },
    lock: { mode: 'pessimistic_read' },
  });

  if (!department) {
    throw new ConflictException('Department is not available for assignment');
  }
}
