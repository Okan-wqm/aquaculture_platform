import { UpdateDepartmentInput } from '../dto/update-department.input';

export class UpdateDepartmentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly input: UpdateDepartmentInput,
    public readonly userId: string,
  ) {}
}
