import { InventoryCountStatus } from '../entities/inventory-count.entity';

export class ListInventoryCountsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly status?: InventoryCountStatus,
    public readonly locationId?: string,
    public readonly page?: number,
    public readonly limit?: number,
  ) {}
}
