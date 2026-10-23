/**
 * DepartmentHeadCountDataLoader
 *
 * Resolves `DepartmentHR.headCount` for every department a response lists with
 * ONE grouped query, not one count per department. Per-request, tenant-scoped
 * (`createTenantScopedDataLoader`), like every batching loader in the platform.
 *
 * The head-count definition is `common/head-count.ts`.
 *
 * @module HR/DataLoaders
 */
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import DataLoader from 'dataloader';
import { Repository } from 'typeorm';

import { HEAD_COUNT_EXCLUDED_STATUS } from '../../common/head-count';
import { Employee } from '../entities/employee.entity';

interface HeadCountRow {
  departmentHrId: string;
  headCount: string;
}

@Injectable({ scope: Scope.REQUEST })
export class DepartmentHeadCountDataLoader {
  private readonly loader: DataLoader<string, number>;

  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {
    this.loader = createTenantScopedDataLoader<string, number>(
      async (tenantId: string, departmentIds: readonly string[]): Promise<number[]> => {
        const rows = await this.employeeRepository
          .createQueryBuilder('employee')
          .select('employee.departmentHrId', 'departmentHrId')
          .addSelect('COUNT(*)', 'headCount')
          .where('employee.tenantId = :tenantId', { tenantId })
          .andWhere('employee.departmentHrId IN (:...departmentIds)', {
            departmentIds: [...departmentIds],
          })
          .andWhere('employee.isDeleted = false')
          .andWhere('employee.status <> :leftStatus', { leftStatus: HEAD_COUNT_EXCLUDED_STATUS })
          .groupBy('employee.departmentHrId')
          .getRawMany<HeadCountRow>();

        const countByDepartment = new Map(
          rows.map((row): [string, number] => [row.departmentHrId, Number(row.headCount)]),
        );
        return departmentIds.map((id) => countByDepartment.get(id) ?? 0);
      },
      { batchFnName: 'DepartmentHeadCountDataLoader' },
    );
  }

  /** The head count of one department. */
  load(departmentId: string): Promise<number> {
    return this.loader.load(departmentId);
  }
}
