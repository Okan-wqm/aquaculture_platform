import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListConsumablesQuery } from '../queries/list-consumables.query';
import { Consumable } from '../entities/consumable.entity';

@QueryHandler(ListConsumablesQuery)
export class ListConsumablesHandler implements IQueryHandler<ListConsumablesQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListConsumablesQuery): Promise<PaginatedQueryResult<Consumable>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const queryBuilder = queryRunner.manager.createQueryBuilder(Consumable, 'consumable');
      queryBuilder.where('consumable.tenantId = :tenantId', { tenantId });
      queryBuilder.andWhere('consumable.isDeleted = :isDeleted', { isDeleted: false });

      if (filter?.category) {
        queryBuilder.andWhere('consumable.category = :category', { category: filter.category });
      }

      if (filter?.status) {
        queryBuilder.andWhere('consumable.status = :status', { status: filter.status });
      }

      if (filter?.supplierId) {
        queryBuilder.andWhere('consumable.supplierId = :supplierId', { supplierId: filter.supplierId });
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('consumable.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(consumable.name ILIKE :search OR consumable.code ILIKE :search OR consumable.brand ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'category', 'status', 'brand', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`consumable.${safeSortBy}`, sortOrder);
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
