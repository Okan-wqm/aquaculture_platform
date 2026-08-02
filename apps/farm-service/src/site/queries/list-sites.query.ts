/**
 * List Sites Query
 */
import { IQuery } from '@platform/cqrs';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { SiteStatus } from '../entities/site.entity';

export interface ListSitesFilter {
  status?: SiteStatus;
  isActive?: boolean;
  search?: string;
  country?: string;
  region?: string;
}

export interface ListSitesPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListSitesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly caller: SiteScopeCaller,
    public readonly filter?: ListSitesFilter,
    public readonly pagination?: ListSitesPagination,
  ) {}
}
