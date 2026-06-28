/**
 * List Systems Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListSystemsQuery } from '../queries/list-systems.query';
import { System } from '../entities/system.entity';

@QueryHandler(ListSystemsQuery)
export class ListSystemsHandler implements IQueryHandler<ListSystemsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSystemsQuery): Promise<PaginatedQueryResult<System>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const queryBuilder = queryRunner.manager.createQueryBuilder(System, 'system');
      queryBuilder.where('system.tenantId = :tenantId', { tenantId });
      queryBuilder.andWhere('system.isDeleted = :isDeleted', { isDeleted: false });

      // Apply filters
      if (filter?.siteId) {
        queryBuilder.andWhere('system.siteId = :siteId', { siteId: filter.siteId });
      }

      if (filter?.departmentId) {
        queryBuilder.andWhere('system.departmentId = :departmentId', { departmentId: filter.departmentId });
      }

      if (filter?.parentSystemId) {
        queryBuilder.andWhere('system.parentSystemId = :parentSystemId', { parentSystemId: filter.parentSystemId });
      }

      if (filter?.type) {
        queryBuilder.andWhere('system.type = :type', { type: filter.type });
      }

      if (filter?.status) {
        queryBuilder.andWhere('system.status = :status', { status: filter.status });
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('system.isActive = :isActive', { isActive: filter.isActive });
      }

      // Root only filter - get systems without parent
      if (filter?.rootOnly) {
        queryBuilder.andWhere('system.parentSystemId IS NULL');
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(system.name ILIKE :search OR system.code ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Join related entities
      queryBuilder.leftJoinAndSelect('system.site', 'site');
      queryBuilder.leftJoinAndSelect('system.department', 'department');
      queryBuilder.leftJoinAndSelect('system.parentSystem', 'parentSystem');

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'type', 'status', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`system.${safeSortBy}`, sortOrder);

      // Apply pagination
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      // Execute query
      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
