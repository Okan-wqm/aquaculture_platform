/**
 * List Feeds Query
 */
import { FeedType, FeedStatus, FloatingType } from '../entities/feed.entity';

export interface FeedFilter {
  type?: FeedType;
  status?: FeedStatus;
  floatingType?: FloatingType;
  pelletSize?: number;
  supplierId?: string;
  siteId?: string;
  speciesId?: string;
  targetSpecies?: string;
  isActive?: boolean;
  search?: string;
}

export interface FeedPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListFeedsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: FeedFilter,
    public readonly pagination?: FeedPagination,
  ) {}
}
