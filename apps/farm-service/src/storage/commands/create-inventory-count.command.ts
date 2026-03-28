import { CreateInventoryCountInput } from '../dto/create-inventory-count.input';

export class CreateInventoryCountCommand {
  constructor(
    public readonly input: CreateInventoryCountInput,
    public readonly tenantId: string,
    public readonly userId: string,
    /** Denormalized user display name from JWT for audit trail */
    public readonly userName?: string,
  ) {}
}
