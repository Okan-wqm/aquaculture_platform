import { IQuery } from '@platform/cqrs';
import { BatchStatus } from '../entities/batch.entity';
import { PaginationOptions } from './list-farms.query';

/**
 * Filter options for batches
 */
export interface BatchFilterOptions {
  status?: BatchStatus;
  species?: string;
  pondId?: string;
  farmId?: string;
}

/**
 * List Pond Batches Query
 * Query to retrieve a list of pond batches with pagination and filters (Farm module version)
 * Note: Renamed from ListBatchesQuery to avoid conflict with Batch module
 */
export class ListPondBatchesQuery implements IQuery {
  readonly queryName = 'ListPondBatches';

  constructor(
    public readonly tenantId: string,
    public readonly pagination: PaginationOptions = { page: 1, limit: 10 },
    public readonly filters?: BatchFilterOptions,
  ) {}
}
