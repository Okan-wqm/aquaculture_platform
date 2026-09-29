/**
 * List Feeding Protocols Query
 */
import { FeedType } from '../entities/feed.entity';
import type { TenantScope } from '@aquaculture/backend-common/database';

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
    public readonly scope: TenantScope,
    public readonly filter?: FeedingProtocolFilter,
    public readonly pagination?: FeedingProtocolPagination,
  ) {}
}
