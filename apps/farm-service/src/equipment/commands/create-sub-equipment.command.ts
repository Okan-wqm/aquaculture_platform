/**
 * Create SubEquipment Command
 */
import { CreateSubEquipmentInput } from '../dto/sub-equipment.input';

export class CreateSubEquipmentCommand {
  constructor(
    public readonly input: CreateSubEquipmentInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
