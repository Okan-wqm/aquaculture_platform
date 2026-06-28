/**
 * List Chemicals Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListChemicalsQuery } from '../queries/list-chemicals.query';
import { Chemical } from '../entities/chemical.entity';
import { ChemicalSite } from '../entities/chemical-site.entity';

@QueryHandler(ListChemicalsQuery)
export class ListChemicalsHandler implements IQueryHandler<ListChemicalsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListChemicalsQuery): Promise<PaginatedQueryResult<Chemical>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Read through the fail-closed tenant boundary.
    const [items, total] = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Build query
      const queryBuilder = queryRunner.manager.createQueryBuilder(Chemical, 'chemical');
      queryBuilder.where('chemical.tenantId = :tenantId', { tenantId });
      // DEFAULT: Only return non-deleted chemicals
      queryBuilder.andWhere('chemical.isDeleted = :isDeleted', { isDeleted: false });

      if (filter?.type) {
        queryBuilder.andWhere('chemical.type = :type', { type: filter.type });
      }

      if (filter?.status) {
        queryBuilder.andWhere('chemical.status = :status', { status: filter.status });
      }

      if (filter?.supplierId) {
        queryBuilder.andWhere('chemical.supplierId = :supplierId', { supplierId: filter.supplierId });
      }

      if (filter?.siteId) {
        queryBuilder.innerJoin(
          ChemicalSite,
          'chemicalSite',
          'chemicalSite.chemicalId = chemical.id AND chemicalSite.tenantId = :tenantId',
          { tenantId }
        );
        queryBuilder.andWhere('chemicalSite.siteId = :siteId', { siteId: filter.siteId });
        queryBuilder.andWhere('chemicalSite.isApproved = true');
      }

      if (filter?.isActive !== undefined) {
        queryBuilder.andWhere('chemical.isActive = :isActive', { isActive: filter.isActive });
      }

      if (filter?.search) {
        queryBuilder.andWhere(
          '(chemical.name ILIKE :search OR chemical.code ILIKE :search OR chemical.activeIngredient ILIKE :search)',
          { search: `%${filter.search}%` }
        );
      }

      // Apply sorting with allowlist to prevent SQL injection
      const validSortFields = ['name', 'code', 'type', 'status', 'activeIngredient', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
      queryBuilder.orderBy(`chemical.${safeSortBy}`, sortOrder);

      // Apply pagination
      queryBuilder.skip((page - 1) * limit);
      queryBuilder.take(limit);

      // Execute query
      return queryBuilder.getManyAndCount();
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
