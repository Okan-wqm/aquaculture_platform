/**
 * List Feeds Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListFeedsQuery } from '../queries/list-feeds.query';
import { Feed } from '../entities/feed.entity';
import { FeedSite } from '../entities/feed-site.entity';
import { FeedTypeSpecies } from '../entities/feed-type-species.entity';

@QueryHandler(ListFeedsQuery)
export class ListFeedsHandler implements IQueryHandler<ListFeedsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListFeedsQuery): Promise<PaginatedQueryResult<Feed>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const queryBuilder = queryRunner.manager.createQueryBuilder(Feed, 'feed');
      queryBuilder.where('feed.tenantId = :tenantId', { tenantId });
      // DEFAULT: Only return non-deleted feeds
      queryBuilder.andWhere('feed.isDeleted = :isDeleted', { isDeleted: false });

      if (filter?.type) {
        queryBuilder.andWhere('feed.type = :type', { type: filter.type });
      }

      if (filter?.status) {
        queryBuilder.andWhere('feed.status = :status', { status: filter.status });
      }

      if (filter?.pelletSize) {
        queryBuilder.andWhere('feed.pelletSize = :pelletSize', { pelletSize: filter.pelletSize });
      }

      if (filter?.supplierId) {
        queryBuilder.andWhere('feed.supplierId = :supplierId', { supplierId: filter.supplierId });
      }

      if (filter?.siteId) {
        queryBuilder.innerJoin(
          FeedSite,
          'feedSite',
          'feedSite.feedId = feed.id AND feedSite.tenantId = :tenantId',
          { tenantId }
        );
        queryBuilder.andWhere('feedSite.siteId = :siteId', { siteId: filter.siteId });
        queryBuilder.andWhere('feedSite.isApproved = true');
      }

      if (filter?.speciesId) {
        queryBuilder.innerJoin(
          FeedTypeSpecies,
          'feedTypeSpecies',
          'feedTypeSpecies.feedId = feed.id AND feedTypeSpecies.tenantId = :tenantId',
          { tenantId }
        );
        queryBuilder.andWhere('feedTypeSpecies.speciesId = :speciesId', { speciesId: filter.speciesId });
        queryBuilder.andWhere('feedTypeSpecies.isActive = true');
        queryBuilder.andWhere('feedTypeSpecies.isDeleted = false');
        queryBuilder.distinct(true);
      }

      if (filter?.targetSpecies) {
        queryBuilder.andWhere(
          `
          EXISTS (
            SELECT 1
            FROM unnest(regexp_split_to_array(coalesce(feed.targetSpecies, ''), '[[:space:]]*,[[:space:]]*')) AS species_list(species)
            WHERE lower(species_list.species) = lower(:species)
          )
          `,
          { species: filter.targetSpecies.trim() }
        );
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('feed.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(feed.name ILIKE :search OR feed.code ILIKE :search OR feed.manufacturer ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'type', 'status', 'pelletSize', 'manufacturer', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`feed.${safeSortBy}`, sortOrder);

      // Apply pagination
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      // Execute query
      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
