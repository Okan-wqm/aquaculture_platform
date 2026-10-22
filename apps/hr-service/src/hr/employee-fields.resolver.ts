import { Parent, ResolveField, Resolver } from '@nestjs/graphql';

import { EmployeeDepartmentDataLoader } from './dataloaders/employee-department.dataloader';
import { DepartmentHR } from './entities/department.entity';
import { Employee } from './entities/employee.entity';

/**
 * Fields of `Employee` that live on another table. `departmentHr` is resolved
 * from `departmentHrId` here and nowhere else: every operation that returns an
 * employee, directly or nested, answers it the same way. Like every field
 * resolver here it runs no guard of its own; the operation that returned the
 * employee decides who may read it (HR-HIGH-056 tracks the ones without a role gate).
 */
@Resolver(() => Employee)
export class EmployeeFieldsResolver {
  constructor(private readonly departments: EmployeeDepartmentDataLoader) {}

  /** The department the employee is placed in; null for an employee placed in none. */
  @ResolveField(() => DepartmentHR, { nullable: true })
  async departmentHr(@Parent() employee: Employee): Promise<DepartmentHR | null> {
    if (!employee.departmentHrId) return null;
    return this.departments.load(employee.departmentHrId);
  }
}
