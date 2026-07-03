/**
 * List Sites Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Site } from '../entities/site.entity';
import { ListSitesQuery } from '../queries/list-sites.query';

@QueryHandler(ListSitesQuery)
export class ListSitesHandler implements IQueryHandler<ListSitesQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSitesQuery): Promise<PaginatedQueryResult<Site>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Apply sorting with allowlist to prevent SQL injection
    const validSortFields = ['name', 'code', 'status', 'country', 'createdAt', 'updatedAt'];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

    // Read through the fail-closed tenant boundary so the query builder runs on
    // a connection whose search_path + RLS GUC are verified for this tenant.
    const [items, total] = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      (queryRunner) => {
        const queryBuilder = queryRunner.manager.createQueryBuilder(Site, 'site');
        queryBuilder.where('site.tenantId = :tenantId', { tenantId });
        // DEFAULT: Only return non-deleted sites
        queryBuilder.andWhere('site.isDeleted = :isDeleted', { isDeleted: false });

        if (filter?.status) {
          queryBuilder.andWhere('site.status = :status', { status: filter.status });
        }

        if (filter?.isActive !== undefined) {
          queryBuilder.andWhere('site.isActive = :isActive', { isActive: filter.isActive });
        }

        if (filter?.country) {
          queryBuilder.andWhere('site.country = :country', { country: filter.country });
        }

        if (filter?.search) {
          queryBuilder.andWhere(
            '(site.name ILIKE :search OR site.code ILIKE :search OR site.description ILIKE :search)',
            { search: `%${filter.search}%` },
          );
        }

        queryBuilder.orderBy(`site.${safeSortBy}`, sortOrder);
        queryBuilder.skip((page - 1) * limit);
        queryBuilder.take(limit);

        return queryBuilder.getManyAndCount();
      },
    );

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
