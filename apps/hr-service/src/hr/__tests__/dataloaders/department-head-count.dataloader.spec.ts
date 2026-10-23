/**
 * DepartmentHeadCountDataLoader — the head count of every department a
 * response lists, in one grouped query instead of one count per department.
 */
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import { collaborator } from '@aquaculture/testing';
import { Repository } from 'typeorm';

import { HEAD_COUNT_EXCLUDED_STATUS } from '../../../common/head-count';
import { DepartmentHeadCountDataLoader } from '../../dataloaders/department-head-count.dataloader';
import { Employee } from '../../entities/employee.entity';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';

describe('DepartmentHeadCountDataLoader', () => {
  const buildLoader = (rows: Array<{ departmentHrId: string; headCount: string }>) => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    const employeeRepository = collaborator<Repository<Employee>>(
      { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) },
      'Repository<Employee>',
    );
    return {
      loader: new DepartmentHeadCountDataLoader(employeeRepository),
      queryBuilder,
      employeeRepository,
    };
  };

  const inTenant = <T>(work: () => Promise<T>): Promise<T> =>
    requestContextStorage.run({ tenantId: TENANT }, work);

  it('counts every department loaded in the same tick with ONE grouped query', async () => {
    const { loader, queryBuilder, employeeRepository } = buildLoader([
      { departmentHrId: 'dep-a', headCount: '3' },
      { departmentHrId: 'dep-b', headCount: '1' },
    ]);

    const counts = await inTenant(() => Promise.all([loader.load('dep-a'), loader.load('dep-b')]));

    expect(counts).toEqual([3, 1]);
    expect(employeeRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(queryBuilder.groupBy).toHaveBeenCalledWith('employee.departmentHrId');
  });

  it('counts a department nobody is placed in as zero', async () => {
    const { loader } = buildLoader([{ departmentHrId: 'dep-a', headCount: '2' }]);

    const counts = await inTenant(() =>
      Promise.all([loader.load('dep-a'), loader.load('dep-empty')]),
    );

    expect(counts).toEqual([2, 0]);
  });

  it('constrains the count to the tenant, to live employees, and leaves out people who left', async () => {
    const { loader, queryBuilder } = buildLoader([]);

    await inTenant(() => loader.load('dep-a'));

    expect(queryBuilder.where).toHaveBeenCalledWith('employee.tenantId = :tenantId', {
      tenantId: TENANT,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'employee.departmentHrId IN (:...departmentIds)',
      {
        departmentIds: ['dep-a'],
      },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('employee.isDeleted = false');
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('employee.status <> :leftStatus', {
      leftStatus: HEAD_COUNT_EXCLUDED_STATUS,
    });
  });

  it('refuses to count without a tenant in the request context', async () => {
    const { loader } = buildLoader([]);

    await expect(loader.load('dep-a')).rejects.toThrow('no tenant id is present');
  });
});
