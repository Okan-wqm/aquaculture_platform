import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListStockMovementsQuery } from '../queries/list-stock-movements.query';
import { StockMovement } from '../entities/stock-movement.entity';

@QueryHandler(ListStockMovementsQuery)
export class ListStockMovementsHandler implements IQueryHandler<ListStockMovementsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListStockMovementsQuery) {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'performedAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager.createQueryBuilder(StockMovement, 'mov');
      qb.where('mov.tenantId = :tenantId', { tenantId });

      if (filter?.movementType) {
        qb.andWhere('mov.movementType = :movementType', { movementType: filter.movementType });
      }

      if (filter?.itemType) {
        qb.andWhere('mov.itemType = :itemType', { itemType: filter.itemType });
      }

      if (filter?.itemId) {
        qb.andWhere('mov.itemId = :itemId', { itemId: filter.itemId });
      }

      if (filter?.locationId) {
        qb.andWhere('(mov.fromLocationId = :locationId OR mov.toLocationId = :locationId)', {
          locationId: filter.locationId,
        });
      }

      if (filter?.fromDate) {
        qb.andWhere('mov.performedAt >= :fromDate', { fromDate: filter.fromDate });
      }

      if (filter?.toDate) {
        qb.andWhere('mov.performedAt <= :toDate', { toDate: filter.toDate });
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['movementType', 'itemType', 'quantity', 'performedAt', 'createdAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'performedAt';
      qb.orderBy(`mov.${safeSortBy}`, sortOrder);
      qb.skip((page - 1) * limit);
      qb.take(limit);

      return qb.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
