/**
 * List Spare Parts (filtered, paginated) Query Handler — fail-closed tenant
 * boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart } from '../entities/spare-part.entity';
import { ListSparePartsQuery } from '../queries/list-spare-parts.query';

@QueryHandler(ListSparePartsQuery)
export class ListSparePartsHandler implements IQueryHandler<ListSparePartsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSparePartsQuery): Promise<IStandardPaginatedResult<SparePart>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(SparePart, 'sp')
        .where('sp.tenantId = :tenantId', { tenantId });

      if (filter?.status?.length) {
        qb.andWhere('sp.status IN (:...statuses)', { statuses: filter.status });
      }
      if (filter?.equipmentTypeId) {
        qb.andWhere('sp.equipmentTypeId = :equipmentTypeId', {
          equipmentTypeId: filter.equipmentTypeId,
        });
      }
      if (filter?.supplierId) {
        qb.andWhere('sp.supplierId = :supplierId', { supplierId: filter.supplierId });
      }
      if (filter?.manufacturer) {
        qb.andWhere('sp.manufacturer ILIKE :manufacturer', {
          manufacturer: `%${filter.manufacturer}%`,
        });
      }
      if (filter?.isActive !== undefined) {
        qb.andWhere('sp.isActive = :isActive', { isActive: filter.isActive });
      }
      if (filter?.isLowStock) {
        qb.andWhere('sp.quantity <= sp.minStock');
        qb.andWhere('sp.quantity > 0');
      }
      if (filter?.isOutOfStock) {
        qb.andWhere('sp.quantity = 0');
      }
      if (filter?.searchTerm) {
        qb.andWhere(
          '(sp.name ILIKE :search OR sp.code ILIKE :search OR sp.partNumber ILIKE :search)',
          { search: `%${filter.searchTerm}%` },
        );
      }

      const total = await qb.getCount();

      const validSortFields = ['name', 'code', 'partNumber', 'quantity', 'status', 'createdAt'];
      const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'name';

      qb.orderBy(`sp.${finalSortBy}`, sortOrder)
        .skip((page - 1) * limit)
        .take(limit);

      const items = await qb.getMany();
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
