import { EmployeeFilterInput } from '../dto/employee-filter.input';

export class GetEmployeesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: EmployeeFilterInput,
    public readonly pagination?: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'ASC' | 'DESC' },
  ) {}
}
