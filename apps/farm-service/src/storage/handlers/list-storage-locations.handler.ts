import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListStorageLocationsQuery } from '../queries/list-storage-locations.query';
import { StorageLocation } from '../entities/storage-location.entity';

@QueryHandler(ListStorageLocationsQuery)
export class ListStorageLocationsHandler implements IQueryHandler<ListStorageLocationsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListStorageLocationsQuery) {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 50;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager.createQueryBuilder(StorageLocation, 'loc');
      qb.where('loc.tenantId = :tenantId', { tenantId });
      qb.andWhere('loc.isDeleted = :isDeleted', { isDeleted: false });

      if (filter?.type) {
        qb.andWhere('loc.type = :type', { type: filter.type });
      }

      if (filter?.siteId) {
        qb.andWhere('loc.siteId = :siteId', { siteId: filter.siteId });
      }

      if (filter?.isActive !== undefined) {
        qb.andWhere('loc.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.search) {
        qb.andWhere(
          '(loc.name ILIKE :search OR loc.code ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'type', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      qb.orderBy(`loc.${safeSortBy}`, sortOrder);
      qb.skip((page - 1) * limit);
      qb.take(limit);

      return qb.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
