/**
 * Get Farm-Stock Inventory Query
 */
import { IQuery } from '@platform/cqrs';
import { FarmStockInventoryFilterInput } from '../dto/farm-stock-inventory.dto';

export class GetFarmStockInventoryQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter: FarmStockInventoryFilterInput = {},
  ) {}
}
