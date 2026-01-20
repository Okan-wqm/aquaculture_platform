/**
 * Update Equipment Command
 * Uses DTOs for input types
 */
import { UpdateEquipmentInput as UpdateEquipmentInputDto } from '../dto/update-equipment.input';

export class UpdateEquipmentCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly input: UpdateEquipmentInputDto,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}

// Re-export input type for convenience
export type UpdateEquipmentInput = UpdateEquipmentInputDto;
