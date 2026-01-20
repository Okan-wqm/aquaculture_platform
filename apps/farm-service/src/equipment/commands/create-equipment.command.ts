/**
 * Create Equipment Command
 * Uses DTOs for input types
 */
import { CreateEquipmentInput as CreateEquipmentInputDto } from '../dto/create-equipment.input';

export class CreateEquipmentCommand {
  constructor(
    public readonly input: CreateEquipmentInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type CreateEquipmentInput = CreateEquipmentInputDto;
