/**
 * ListInventoryCounts Query Handler
 *
 * Paginated list of inventory counts with optional status and location filters.
 * Items are eager-loaded for the response to avoid N+1 queries in the
 * frontend grid view.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListInventoryCountsQuery } from '../queries/list-inventory-counts.query';
import { InventoryCount } from '../entities/inventory-count.entity';

@QueryHandler(ListInventoryCountsQuery)
export class ListInventoryCountsHandler implements IQueryHandler<ListInventoryCountsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListInventoryCountsQuery) {
    const { tenantId, status, locationId, page = 1, limit = 50 } = query;

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager.createQueryBuilder(InventoryCount, 'ic')
        .leftJoinAndSelect('ic.items', 'items')
        .where('ic.tenantId = :tenantId', { tenantId });

      if (status) {
        qb.andWhere('ic.status = :status', { status });
      }
      if (locationId) {
        qb.andWhere('ic.storageLocationId = :locationId', { locationId });
      }

      qb.orderBy('ic.createdAt', 'DESC');

      return qb
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
