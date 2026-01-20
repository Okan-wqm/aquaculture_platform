import { PayrollStatus } from '../entities/payroll.entity';

export interface PayrollFilterInput {
  employeeId?: string;
  status?: PayrollStatus;
  startDate?: Date;
  endDate?: Date;
  offset?: number;
  limit?: number;
}

export class GetPayrollsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: PayrollFilterInput,
  ) {}
}
