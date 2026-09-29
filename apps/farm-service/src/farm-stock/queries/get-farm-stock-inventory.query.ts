/**
 * Get Farm-Stock Inventory Query
 */
import { FarmStockInventoryFilterInput } from '../dto/farm-stock-inventory.dto';
import type { TenantScope } from '@aquaculture/backend-common/database';

export class GetFarmStockInventoryQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly filter: FarmStockInventoryFilterInput = {},
  ) {}
}
