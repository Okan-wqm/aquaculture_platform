import { CreateDepartmentInput } from '../dto/create-department.input';

export class CreateDepartmentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: CreateDepartmentInput,
    public readonly userId: string,
  ) {}
}
