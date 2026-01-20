/**
 * Create Department Command
 * Uses DTOs for input types
 */
import { CreateDepartmentInput as CreateDepartmentInputDto } from '../dto/create-department.input';

export class CreateDepartmentCommand {
  constructor(
    public readonly input: CreateDepartmentInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateDepartmentInput = CreateDepartmentInputDto;
