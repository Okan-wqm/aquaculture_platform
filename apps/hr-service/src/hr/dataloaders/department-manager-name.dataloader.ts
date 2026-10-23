/**
 * DepartmentManagerNameDataLoader
 *
 * Resolves `DepartmentHR.managerName`: the display name of each department's
 * manager, for every department a response lists, with ONE query. Only the name
 * leaves the loader — reading a department does not hand its reader the
 * manager's employee record (contact PII stays behind the employee queries).
 *
 * `departments_hr.managerId` is free text with no foreign key, while `employees.id` is a uuid, so a
 * malformed value would make Postgres reject the whole batch and fail every manager in the
 * response. Only well-formed ids are queried; the rest have no manager to name.
 *
 * @module HR/DataLoaders
 */
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import DataLoader from 'dataloader';
import { In, Repository } from 'typeorm';

import { Employee } from '../entities/employee.entity';

@Injectable({ scope: Scope.REQUEST })
export class DepartmentManagerNameDataLoader {
  private readonly loader: DataLoader<string, string | null>;

  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {
    this.loader = createTenantScopedDataLoader<string, string | null>(
      async (tenantId: string, managerIds: readonly string[]): Promise<Array<string | null>> => {
        const wellFormedIds = managerIds.filter((id) => isUUID(id));
        const managers =
          wellFormedIds.length === 0
            ? []
            : await this.employeeRepository.find({
                where: { tenantId, id: In(wellFormedIds), isDeleted: false },
                select: { id: true, firstName: true, lastName: true },
              });

        const nameById = new Map(
          managers.map((manager): [string, string] => [
            manager.id,
            `${manager.firstName} ${manager.lastName}`,
          ]),
        );
        return managerIds.map((id) => nameById.get(id) ?? null);
      },
      { batchFnName: 'DepartmentManagerNameDataLoader' },
    );
  }

  /** The name of one manager; null when that employee no longer exists. */
  load(managerId: string): Promise<string | null> {
    return this.loader.load(managerId);
  }
}
