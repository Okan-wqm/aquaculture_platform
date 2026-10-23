/**
 * assertAssignableDepartment — the one rule for "may an employee be placed in
 * this department".
 *
 * An employee's module is read through their department, so placing someone in
 * a department that is gone (soft-deleted), switched off, or belongs to another
 * tenant would put them in no module or the wrong one. Create and update both
 * ask this single function; nothing else validates a department assignment.
 */
import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { DepartmentHR } from '../entities/department.entity';
import { assertAssignableDepartment } from '../services/assignable-department';

const tenantId = 'tenant-uuid-001';
const departmentHrId = '3f1c2b8e-9d4a-4c61-8f0e-5a7b2d9c1e44';

function buildManager(found: DepartmentHR | null): {
  manager: EntityManager;
  findOne: jest.Mock;
  getRepository: jest.Mock;
} {
  const findOne = jest.fn().mockResolvedValue(found);
  const getRepository = jest.fn().mockReturnValue({ findOne });
  // Only getRepository is reachable from tenantManagerRepo; the double is
  // declared as a Partial so no cast is needed to pass it as a manager.
  const partial: Partial<EntityManager> = { getRepository };
  return { manager: partial as EntityManager, findOne, getRepository };
}

describe('assertAssignableDepartment', () => {
  it('accepts a live department of the tenant', async () => {
    const { manager } = buildManager(new DepartmentHR());

    await expect(
      assertAssignableDepartment(manager, tenantId, departmentHrId),
    ).resolves.toBeUndefined();
  });

  it('looks the department up through the tenant-scoped repository of DepartmentHR', async () => {
    const { manager, findOne, getRepository } = buildManager(new DepartmentHR());

    await assertAssignableDepartment(manager, tenantId, departmentHrId);

    expect(getRepository).toHaveBeenCalledWith(DepartmentHR);
    // tenantId is merged into the predicate by the scoped repository: a
    // department of another tenant can never satisfy it.
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: departmentHrId, isDeleted: false, isActive: true, tenantId },
      }),
    );
  });

  it('holds a share lock on the department row until the placement commits', async () => {
    // WHY: deleting a department counts its members under a write lock on the same row, so a
    // placement and a delete cannot both pass their check and leave the employee in a deleted department.
    const { manager, findOne } = buildManager(new DepartmentHR());

    await assertAssignableDepartment(manager, tenantId, departmentHrId);

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_read' } }),
    );
  });

  it('rejects a department that is missing, soft-deleted, inactive or of another tenant', async () => {
    // All four are the same query answering "no live department" — the
    // predicate lives in the where clause asserted above, not in a second check.
    const { manager } = buildManager(null);

    await expect(assertAssignableDepartment(manager, tenantId, departmentHrId)).rejects.toThrow(
      ConflictException,
    );
  });

  it('names the problem so the form can show it', async () => {
    const { manager } = buildManager(null);

    await expect(assertAssignableDepartment(manager, tenantId, departmentHrId)).rejects.toThrow(
      'Department is not available for assignment',
    );
  });
});
