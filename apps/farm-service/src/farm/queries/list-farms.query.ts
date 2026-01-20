import { IQuery } from '@platform/cqrs';

/**
 * Pagination options
 */
export interface PaginationOptions {
  page: number;
  limit: number;
}

/**
 * Filter options for farms
 */
export interface FarmFilterOptions {
  isActive?: boolean;
  search?: string;
}

/**
 * List Farms Query
 * Query to retrieve a list of farms with pagination
 */
export class ListFarmsQuery implements IQuery {
  readonly queryName = 'ListFarms';

  constructor(
    public readonly tenantId: string,
    public readonly pagination: PaginationOptions = { page: 1, limit: 10 },
    public readonly filters?: FarmFilterOptions,
    public readonly includePonds: boolean = false,
  ) {}
}
