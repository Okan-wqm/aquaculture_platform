/**
 * Update SubEquipment Command
 */
import { UpdateSubEquipmentInput } from '../dto/sub-equipment.input';

export class UpdateSubEquipmentCommand {
  constructor(
    public readonly id: string,
    public readonly input: UpdateSubEquipmentInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
