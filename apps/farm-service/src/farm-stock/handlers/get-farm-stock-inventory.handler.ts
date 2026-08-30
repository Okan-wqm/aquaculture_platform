/**
 * Get Farm-Stock Inventory Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060). Reads the container snapshots (filtered, paginated) and their
 * batch snapshots on the asserted tenant connection, then assembles the
 * inventory connection.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource, In } from 'typeorm';

import {
  FarmStockInventoryConnection,
  FarmStockInventoryItem,
} from '../dto/farm-stock-inventory.dto';
import { FarmStockBatchSnapshot } from '../entities/farm-stock-batch-snapshot.entity';
import { FarmStockContainerSnapshot } from '../entities/farm-stock-container-snapshot.entity';
import { GetFarmStockInventoryQuery } from '../queries/get-farm-stock-inventory.query';

@QueryHandler(GetFarmStockInventoryQuery)
export class GetFarmStockInventoryHandler implements IQueryHandler<GetFarmStockInventoryQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetFarmStockInventoryQuery): Promise<FarmStockInventoryConnection> {
    const { tenantId, filter } = query;
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 100);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(FarmStockContainerSnapshot, 'container')
        .where('container.tenantId = :tenantId', { tenantId });

      if (filter.containerSources?.length) {
        qb.andWhere('container.containerSource IN (:...containerSources)', {
          containerSources: filter.containerSources,
        });
      }
      if (filter.departmentId) {
        qb.andWhere('container.departmentId = :departmentId', {
          departmentId: filter.departmentId,
        });
      }
      if (filter.siteId) {
        qb.andWhere('container.siteId = :siteId', { siteId: filter.siteId });
      }
      if (filter.status) {
        qb.andWhere('container.status = :status', { status: filter.status });
      }
      if (filter.isActive !== undefined) {
        qb.andWhere('container.isActive = :isActive', { isActive: filter.isActive });
      }
      if (filter.hasActiveBatch !== undefined) {
        qb.andWhere('container.hasActiveBatch = :hasActiveBatch', {
          hasActiveBatch: filter.hasActiveBatch,
        });
      }
      if (filter.search) {
        qb.andWhere('(container.name ILIKE :search OR container.code ILIKE :search)', {
          search: `%${filter.search}%`,
        });
      }

      const total = await qb.getCount();
      const containers = await qb
        .orderBy('container.name', 'ASC')
        .addOrderBy('container.containerId', 'ASC')
        .skip((page - 1) * limit)
        .take(limit)
        .getMany();

      const containerIds = containers.map((container) => container.containerId);
      // FARM-LOW-216: primary batch FIRST — consumers (the mobile tank mapper
      // in particular) treat batches[0] as the container's primary batch for
      // species/batch attribution. Alphabetical-only ordering made that pick
      // non-deterministic on mixed-batch containers.
      const batches = containerIds.length
        ? await queryRunner.manager.find(FarmStockBatchSnapshot, {
            where: { tenantId, containerId: In(containerIds) },
            order: { isPrimary: 'DESC', batchNumber: 'ASC' },
          })
        : [];

      const batchesByContainer = new Map<string, FarmStockBatchSnapshot[]>();
      for (const batch of batches) {
        const existing = batchesByContainer.get(batch.containerId) ?? [];
        existing.push(batch);
        batchesByContainer.set(batch.containerId, existing);
      }

      const items: FarmStockInventoryItem[] = containers.map((container) => ({
        container,
        batches: batchesByContainer.get(container.containerId) ?? [],
      }));

      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
