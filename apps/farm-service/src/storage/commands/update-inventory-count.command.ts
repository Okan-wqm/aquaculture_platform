import { UpdateInventoryCountItemsInput } from '../dto/update-inventory-count-items.input';

export class UpdateInventoryCountCommand {
  constructor(
    public readonly input: UpdateInventoryCountItemsInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
