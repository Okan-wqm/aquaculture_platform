/**
 * GetFeedInventoryQuery
 *
 * Yem stok bilgilerini getirir.
 *
 * @module Feeding/Queries
 */
import { ITenantQuery, IPaginatedQuery } from '@platform/cqrs';
import { InventoryStatus } from '../entities/feed-inventory.entity';

/**
 * Stok filtresi
 */
export interface FeedInventoryFilter {
  feedId?: string;
  siteId?: string;
  departmentId?: string;
  status?: InventoryStatus[];
  lowStockOnly?: boolean;
  expiringWithinDays?: number;
}

export class GetFeedInventoryQuery implements ITenantQuery, IPaginatedQuery {
  readonly queryName = 'GetFeedInventoryQuery';

  constructor(
    public readonly tenantId: string,
    public readonly filter?: FeedInventoryFilter,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'quantityKg',
    public readonly sortOrder: 'ASC' | 'DESC' = 'DESC',
  ) {}
}
