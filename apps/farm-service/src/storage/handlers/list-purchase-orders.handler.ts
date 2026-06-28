import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListPurchaseOrdersQuery } from '../queries/list-purchase-orders.query';
import { PurchaseOrder } from '../entities/purchase-order.entity';

@QueryHandler(ListPurchaseOrdersQuery)
export class ListPurchaseOrdersHandler implements IQueryHandler<ListPurchaseOrdersQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListPurchaseOrdersQuery) {
    const { tenantId, category, status, page = 1, limit = 50 } = query;

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager.createQueryBuilder(PurchaseOrder, 'po')
        .leftJoinAndSelect('po.items', 'items')
        .where('po.tenantId = :tenantId', { tenantId })
        .andWhere('po.isDeleted = :isDeleted', { isDeleted: false });

      if (category) {
        qb.andWhere('po.category = :category', { category });
      }
      if (status) {
        qb.andWhere('po.status = :status', { status });
      }

      qb.orderBy('po.createdAt', 'DESC');

      return qb
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
