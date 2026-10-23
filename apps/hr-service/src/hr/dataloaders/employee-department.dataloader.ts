/**
 * EmployeeDepartmentDataLoader
 *
 * Resolves `Employee.departmentHr` for every employee a response lists with ONE
 * query. It is the single place that field is read, so it is right however the
 * employee was loaded — list, detail, mutation result, or nested in a leave
 * request or a roster — instead of depending on each handler remembering to
 * join the relation.
 *
 * A soft-deleted department is still returned: an employee stays in it until
 * they are moved.
 *
 * @module HR/DataLoaders
 */
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import DataLoader from 'dataloader';
import { In, Repository } from 'typeorm';

import { DepartmentHR } from '../entities/department.entity';

@Injectable({ scope: Scope.REQUEST })
export class EmployeeDepartmentDataLoader {
  private readonly loader: DataLoader<string, DepartmentHR | null>;

  constructor(
    @InjectRepository(DepartmentHR)
    private readonly departmentRepository: Repository<DepartmentHR>,
  ) {
    this.loader = createTenantScopedDataLoader<string, DepartmentHR | null>(
      async (
        tenantId: string,
        departmentIds: readonly string[],
      ): Promise<Array<DepartmentHR | null>> => {
        const departments = await this.departmentRepository.find({
          where: { tenantId, id: In([...departmentIds]) },
        });

        const departmentById = new Map(
          departments.map((department): [string, DepartmentHR] => [department.id, department]),
        );
        return departmentIds.map((id) => departmentById.get(id) ?? null);
      },
      { batchFnName: 'EmployeeDepartmentDataLoader' },
    );
  }

  /** The department with this id; null when it is not in the tenant. */
  load(departmentId: string): Promise<DepartmentHR | null> {
    return this.loader.load(departmentId);
  }
}
