import { CreateEmployeeInput } from '../dto/create-employee.input';

export class CreateEmployeeCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateEmployeeInput,
    public readonly userId: string,
  ) {}
}
