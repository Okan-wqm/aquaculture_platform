/**
 * List Suppliers Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListSuppliersQuery } from '../queries/list-suppliers.query';
import { Supplier } from '../entities/supplier.entity';

@QueryHandler(ListSuppliersQuery)
export class ListSuppliersHandler implements IQueryHandler<ListSuppliersQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSuppliersQuery): Promise<PaginatedQueryResult<Supplier>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const queryBuilder = queryRunner.manager.createQueryBuilder(Supplier, 'supplier');
      queryBuilder.where('supplier.tenantId = :tenantId', { tenantId });
      // DEFAULT: Only return non-deleted suppliers
      queryBuilder.andWhere('supplier.isDeleted = :isDeleted', { isDeleted: false });

      if (filter?.type) {
        queryBuilder.andWhere('supplier.type = :type', { type: filter.type });
      }

      if (filter?.status) {
        queryBuilder.andWhere('supplier.status = :status', { status: filter.status });
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('supplier.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.country) {
        queryBuilder.andWhere('supplier.country = :country', { country: filter.country });
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(supplier.name ILIKE :search OR supplier.code ILIKE :search OR supplier.email ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'type', 'status', 'country', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`supplier.${safeSortBy}`, sortOrder);

      // Apply pagination
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      // Execute query
      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
