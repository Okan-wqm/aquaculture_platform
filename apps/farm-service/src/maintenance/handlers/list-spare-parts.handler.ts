/**
 * List Spare Parts (filtered, paginated) Query Handler — fail-closed tenant
 * boundary.
 *
 * WHY the page is selected in SQL (V-B1-12 of the B1a-1 verifier round): the
 * list used to load every part of the tenant and derive every part's stock in
 * TypeScript before it could filter, sort and slice one page. Quantity and
 * status are no longer columns anyone writes (FARM-HIGH-338) — they are
 * derived from the storage ledger — so the stock filters and sorts read the
 * SQL rendering of that ONE rule (`sparePartStockSql`), and only the page's
 * parts are loaded. Filtering on the legacy columns would silently use numbers
 * that stopped moving.
 */
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import { ListSparePartsQuery } from '../queries/list-spare-parts.query';
import { sparePartStockSql } from '../services/spare-part-stock.sql';

/** Sort keys that read catalogue columns directly. */
const COLUMN_SORTS: ReadonlySet<string> = new Set(['name', 'code', 'partNumber', 'createdAt']);

@QueryHandler(ListSparePartsQuery)
export class ListSparePartsHandler implements IQueryHandler<ListSparePartsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSparePartsQuery): Promise<IStandardPaginatedResult<SparePart>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = tenantManagerRepo(queryRunner.manager, SparePart, tenantId).createQueryBuilder(
        'sp',
      );
      const stock = sparePartStockSql(queryRunner.manager, 'sp');
      qb.setParameters(stock.parameters);

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
      if (filter?.searchTerm) {
        qb.andWhere(
          '(sp.name ILIKE :search OR sp.code ILIKE :search OR sp.partNumber ILIKE :search)',
          { search: `%${filter.searchTerm}%` },
        );
      }
      // The ONE derivation (deriveSparePartStatus, rendered in SQL) decides
      // every stock filter.
      if (filter?.status?.length) {
        qb.andWhere(`${stock.status} IN (:...stockStatuses)`, { stockStatuses: filter.status });
      }
      if (filter?.isLowStock) {
        qb.andWhere(`${stock.status} = :lowStockStatus`, {
          lowStockStatus: SparePartStatus.LOW_STOCK,
        });
      }
      if (filter?.isOutOfStock) {
        qb.andWhere(`${stock.status} = :outOfStockStatus`, {
          outOfStockStatus: SparePartStatus.OUT_OF_STOCK,
        });
      }

      if (sortBy === 'quantity') {
        qb.orderBy(stock.onHand, sortOrder);
      } else if (sortBy === 'status') {
        qb.orderBy(stock.status, sortOrder);
      } else {
        qb.orderBy(`sp.${COLUMN_SORTS.has(sortBy) ? sortBy : 'name'}`, sortOrder);
      }
      // A total order, so a page boundary never splits or repeats a part.
      qb.addOrderBy('sp.id', 'ASC');

      const total = await qb.getCount();
      const items = await qb
        .offset((page - 1) * limit)
        .limit(limit)
        .getMany();
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
