/**
 * List Feeding Protocols Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListFeedingProtocolsQuery } from '../queries/list-feeding-protocols.query';
import { FeedingProtocol } from '../entities/feeding-protocol.entity';

@QueryHandler(ListFeedingProtocolsQuery)
export class ListFeedingProtocolsHandler implements IQueryHandler<ListFeedingProtocolsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListFeedingProtocolsQuery): Promise<PaginatedQueryResult<FeedingProtocol>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const queryBuilder = queryRunner.manager.createQueryBuilder(FeedingProtocol, 'protocol');
      queryBuilder.where('protocol.tenantId = :tenantId', { tenantId });

      // Apply filters
      if (filter?.stage) {
        queryBuilder.andWhere('protocol.stage = :stage', { stage: filter.stage });
      }

      if (filter?.species) {
        queryBuilder.andWhere('protocol.species ILIKE :species', { species: `%${filter.species}%` });
      }

      if (filter?.feedId) {
        queryBuilder.andWhere('protocol.feedId = :feedId', { feedId: filter.feedId });
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('protocol.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.isDefault !== undefined) {
        queryBuilder.andWhere('protocol.isDefault = :isDefault', { isDefault: filter.isDefault });
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(protocol.name ILIKE :search OR protocol.description ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'stage', 'species', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`protocol.${safeSortBy}`, sortOrder);

      // Apply pagination
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      // Add relations
      queryBuilder.leftJoinAndSelect('protocol.feed', 'feed');

      // Execute query
      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
