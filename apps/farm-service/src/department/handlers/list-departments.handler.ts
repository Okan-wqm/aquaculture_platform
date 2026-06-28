/**
 * List Departments Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListDepartmentsQuery } from '../queries/list-departments.query';
import { Department } from '../entities/department.entity';

@QueryHandler(ListDepartmentsQuery)
export class ListDepartmentsHandler implements IQueryHandler<ListDepartmentsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListDepartmentsQuery): Promise<PaginatedQueryResult<Department>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const queryBuilder = queryRunner.manager.createQueryBuilder(Department, 'department');
      queryBuilder.where('department.tenantId = :tenantId', { tenantId });
      // DEFAULT: Only return non-deleted departments
      queryBuilder.andWhere('department.isDeleted = :isDeleted', { isDeleted: false });

      if (filter?.siteId) {
        queryBuilder.andWhere('department.siteId = :siteId', { siteId: filter.siteId });
      }

      if (filter?.type) {
        queryBuilder.andWhere('department.type = :type', { type: filter.type });
      }

      if (filter?.status) {
        queryBuilder.andWhere('department.status = :status', { status: filter.status });
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('department.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(department.name ILIKE :search OR department.code ILIKE :search OR department.description ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Join site for additional info
      queryBuilder.leftJoinAndSelect('department.site', 'site');

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'type', 'status', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`department.${safeSortBy}`, sortOrder);

      // Apply pagination
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      // Execute query
      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
