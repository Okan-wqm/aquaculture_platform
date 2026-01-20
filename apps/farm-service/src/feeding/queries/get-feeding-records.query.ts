/**
 * GetFeedingRecordsQuery
 *
 * Yemleme kayıtlarını filtrelenmiş olarak getirir.
 *
 * @module Feeding/Queries
 */
import { ITenantQuery, IPaginatedQuery } from '@platform/cqrs';
import { FeedingMethod, FishAppetite } from '../entities/feeding-record.entity';

/**
 * Yemleme kaydı filtresi
 */
export interface FeedingRecordFilter {
  batchId?: string;
  tankId?: string;
  feedId?: string;
  fromDate?: Date;
  toDate?: Date;
  feedingMethod?: FeedingMethod[];
  appetite?: FishAppetite[];
  fedBy?: string;
  hasVariance?: boolean;
}

export class GetFeedingRecordsQuery implements ITenantQuery, IPaginatedQuery {
  readonly queryName = 'GetFeedingRecordsQuery';

  constructor(
    public readonly tenantId: string,
    public readonly filter?: FeedingRecordFilter,
    public readonly page: number = 1,
    public readonly limit: number = 20,
    public readonly sortBy: string = 'feedingDate',
    public readonly sortOrder: 'ASC' | 'DESC' = 'DESC',
  ) {}
}
