/**
 * DepartmentManagerNameDataLoader — the display name of each department's
 * manager. Only the name leaves the loader: a department's reader is not
 * thereby handed the manager's employee record.
 */
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { collaborator } from '@aquaculture/testing';
import { In, Repository } from 'typeorm';

import { DepartmentManagerNameDataLoader } from '../../dataloaders/department-manager-name.dataloader';
import { Employee } from '../../entities/employee.entity';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const EMP_1 = '0b7e5c1a-6f2d-4b8e-9a31-2c4d5e6f7a81';
const EMP_2 = '0b7e5c1a-6f2d-4b8e-9a31-2c4d5e6f7a82';

describe('DepartmentManagerNameDataLoader', () => {
  const buildLoader = (people: Array<Pick<Employee, 'id' | 'firstName' | 'lastName'>>) => {
    const find = jest.fn().mockResolvedValue(people);
    const loader = new DepartmentManagerNameDataLoader(
      collaborator<Repository<Employee>>({ find }, 'Repository<Employee>'),
    );
    return { loader, find };
  };

  const inTenant = <T>(work: () => Promise<T>): Promise<T> =>
    requestContextStorage.run({ tenantId: TENANT }, work);

  it('names every manager loaded in the same tick with ONE query', async () => {
    const { loader, find } = buildLoader([
      { id: EMP_1, firstName: 'Ada', lastName: 'Kaya' },
      { id: EMP_2, firstName: 'Mert', lastName: 'Demir' },
    ]);

    const names = await inTenant(() => Promise.all([loader.load(EMP_1), loader.load(EMP_2)]));

    expect(names).toEqual(['Ada Kaya', 'Mert Demir']);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({
      where: { tenantId: TENANT, id: In([EMP_1, EMP_2]), isDeleted: false },
      select: { id: true, firstName: true, lastName: true },
    });
  });

  it('answers null for a malformed managerId instead of failing every manager in the response', async () => {
    const { loader, find } = buildLoader([{ id: EMP_1, firstName: 'Ada', lastName: 'Kaya' }]);

    const names = await inTenant(() => Promise.all([loader.load(EMP_1), loader.load('emp-007')]));

    expect(names).toEqual(['Ada Kaya', null]);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: In([EMP_1]) }) }),
    );
  });

  it('runs no query when no managerId is well formed', async () => {
    const { loader, find } = buildLoader([]);

    expect(await inTenant(() => loader.load('emp-007'))).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it('answers null for a manager who no longer exists', async () => {
    const { loader } = buildLoader([{ id: EMP_1, firstName: 'Ada', lastName: 'Kaya' }]);

    const names = await inTenant(() => Promise.all([loader.load(EMP_1), loader.load(EMP_2)]));

    expect(names).toEqual(['Ada Kaya', null]);
  });
});
