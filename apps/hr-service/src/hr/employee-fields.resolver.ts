import { CurrentUser } from '@aquaculture/backend-common/decorators';
import type { CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';

import { EmployeeDepartmentDataLoader } from './dataloaders/employee-department.dataloader';
import { DepartmentHR } from './entities/department.entity';
import { Address, ContactInfo, Employee } from './entities/employee.entity';
import {
  canViewEmployeeContact,
  redactAddress,
  redactContactInfo,
} from './services/employee-contact-privacy';

/**
 * Fields of `Employee` whose value depends on where it is stored or who is asking. Like every
 * field resolver here it runs no guard of its own: the operation that returned the employee
 * decides who may reach it (`tests/invariants/hr-operation-role-gates.spec.ts`), and these fields
 * decide what of the employee that reader sees.
 *
 * - `departmentHr` is resolved from `departmentHrId` here and nowhere else: every operation that
 *   returns an employee, directly or nested, answers it the same way.
 * - `contactInfo` and `address` are redacted for a viewer who may not read them, on every path
 *   that returns an employee, so no operation has to remember to mask (HR-HIGH-056).
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

  /** Phone numbers and emergency contacts: full for a workforce manager or the employee. */
  @ResolveField(() => ContactInfo)
  contactInfo(
    @Parent() employee: Employee,
    @CurrentUser() viewer: CurrentUserPayload,
  ): ContactInfo {
    return canViewEmployeeContact(employee, viewer)
      ? employee.contactInfo
      : redactContactInfo(employee.contactInfo);
  }

  /** Home address: full for a workforce manager or the employee. */
  @ResolveField(() => Address)
  address(@Parent() employee: Employee, @CurrentUser() viewer: CurrentUserPayload): Address {
    return canViewEmployeeContact(employee, viewer) ? employee.address : redactAddress();
  }
}
