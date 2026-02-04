/**
 * List Feeding Protocols Query
 */
import { FeedType } from '../entities/feed.entity';

export interface FeedingProtocolFilter {
  stage?: FeedType;
  species?: string;
  feedId?: string;
  isActive?: boolean;
  isDefault?: boolean;
  search?: string;
}

export interface FeedingProtocolPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListFeedingProtocolsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: FeedingProtocolFilter,
    public readonly pagination?: FeedingProtocolPagination,
  ) {}
}
