import { EmployeeFilterInput, EmployeePaginationInput } from '../dto/employee-filter.input';

export class GetEmployeesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: EmployeeFilterInput,
    public readonly pagination?: EmployeePaginationInput,
  ) {}
}
