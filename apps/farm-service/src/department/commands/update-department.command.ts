/**
 * Update Department Command
 * Uses DTOs for input types
 */
import { UpdateDepartmentInput as UpdateDepartmentInputDto } from '../dto/update-department.input';

export class UpdateDepartmentCommand {
  constructor(
    public readonly departmentId: string,
    public readonly input: UpdateDepartmentInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateDepartmentInput = UpdateDepartmentInputDto;
