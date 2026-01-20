import { CreatePayrollInput } from '../dto/create-payroll.input';

export class CreatePayrollCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreatePayrollInput,
    public readonly userId: string,
  ) {}
}
