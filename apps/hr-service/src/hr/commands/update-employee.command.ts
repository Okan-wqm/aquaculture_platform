import { UpdateEmployeeInput } from '../dto/update-employee.input';

export class UpdateEmployeeCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdateEmployeeInput,
    public readonly userId: string,
  ) {}
}
