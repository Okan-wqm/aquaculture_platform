/**
 * EmployeeDepartmentDataLoader — the department of each employee a response
 * lists. It is the one place `Employee.departmentHr` is read, so the field is
 * right however the employee was loaded (list, detail, mutation, or nested
 * inside a leave request or a roster).
 */
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { collaborator } from '@aquaculture/testing';
import { In, Repository } from 'typeorm';

import { EmployeeDepartmentDataLoader } from '../../dataloaders/employee-department.dataloader';
import { DepartmentHR } from '../../entities/department.entity';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';

describe('EmployeeDepartmentDataLoader', () => {
  const department = (id: string): DepartmentHR => Object.assign(new DepartmentHR(), { id });

  const buildLoader = (rows: DepartmentHR[]) => {
    const find = jest.fn().mockResolvedValue(rows);
    const loader = new EmployeeDepartmentDataLoader(
      collaborator<Repository<DepartmentHR>>({ find }, 'Repository<DepartmentHR>'),
    );
    return { loader, find };
  };

  const inTenant = <T>(work: () => Promise<T>): Promise<T> =>
    requestContextStorage.run({ tenantId: TENANT }, work);

  it('loads every department asked for in the same tick with ONE query, tenant-constrained', async () => {
    const { loader, find } = buildLoader([department('dep-a'), department('dep-b')]);

    const loaded = await inTenant(() => Promise.all([loader.load('dep-a'), loader.load('dep-b')]));

    expect(loaded.map((d) => d?.id)).toEqual(['dep-a', 'dep-b']);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ where: { tenantId: TENANT, id: In(['dep-a', 'dep-b']) } });
  });

  it('keeps a soft-deleted department: an employee still sits in it until moved', async () => {
    const deleted = Object.assign(department('dep-old'), { isDeleted: true });
    const { loader } = buildLoader([deleted]);

    const loaded = await inTenant(() => loader.load('dep-old'));

    expect(loaded?.isDeleted).toBe(true);
  });

  it('answers null for a department that does not exist in the tenant', async () => {
    const { loader } = buildLoader([]);

    expect(await inTenant(() => loader.load('dep-other-tenant'))).toBeNull();
  });
});
