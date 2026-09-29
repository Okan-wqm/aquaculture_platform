/**
 * List Spare Parts (filtered, paginated) Query Handler — fail-closed tenant
 * boundary.
 *
 * WHY stock filters run after the ledger read (FARM-HIGH-338): quantity and
 * status are no longer columns anyone writes — they are derived from the
 * storage ledger by SparePartStockReader. Filtering or sorting on the legacy
 * columns in SQL would silently use numbers that stopped moving. The
 * catalogue filters stay in SQL; the stock filters, the stock sorts and the
 * page slice apply to the derived values, with the ONE derivation rule.
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
import {
  requireStockView,
  SparePartStockReader,
  SparePartStockView,
} from '../services/spare-part-stock.reader';

/** Sort keys that read catalogue columns directly. */
const COLUMN_SORTS: ReadonlySet<string> = new Set(['name', 'code', 'partNumber', 'createdAt']);

@QueryHandler(ListSparePartsQuery)
export class ListSparePartsHandler implements IQueryHandler<ListSparePartsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockReader: SparePartStockReader,
  ) {}

  async execute(query: ListSparePartsQuery): Promise<IStandardPaginatedResult<SparePart>> {
    const { tenantId, filter, page, limit, sortBy, sortOrder } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = tenantManagerRepo(queryRunner.manager, SparePart, tenantId).createQueryBuilder(
        'sp',
      );

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
      const columnSort = COLUMN_SORTS.has(sortBy) ? sortBy : 'name';
      qb.orderBy(`sp.${columnSort}`, sortOrder);

      const candidates = await qb.getMany();
      const stock = await this.stockReader.read(queryRunner.manager, tenantId, candidates);
      const viewOf = (part: SparePart): SparePartStockView => requireStockView(stock, part.id);

      let rows = candidates.filter((part) => {
        const view = viewOf(part);
        if (filter?.status?.length && !filter.status.includes(view.status)) return false;
        // The ONE derivation (deriveSparePartStatus) decides both filters.
        if (filter?.isLowStock && view.status !== SparePartStatus.LOW_STOCK) return false;
        if (filter?.isOutOfStock && view.status !== SparePartStatus.OUT_OF_STOCK) return false;
        return true;
      });

      if (sortBy === 'quantity' || sortBy === 'status') {
        const direction = sortOrder === 'DESC' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const left = viewOf(a);
          const right = viewOf(b);
          const order =
            sortBy === 'quantity'
              ? left.onHand - right.onHand
              : left.status.localeCompare(right.status);
          return order * direction;
        });
      }

      const items = rows.slice((page - 1) * limit, page * limit);
      return createStandardPaginatedResult(items, rows.length, page, limit);
    });
  }
}
