import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  FarmStockInventoryConnection,
  FarmStockInventoryFilterInput,
  FarmStockInventoryItem,
} from './dto/farm-stock-inventory.dto';
import { FarmStockBatchSnapshot } from './entities/farm-stock-batch-snapshot.entity';
import { FarmStockContainerSnapshot } from './entities/farm-stock-container-snapshot.entity';

@Injectable()
export class FarmStockService {
  constructor(
    @InjectRepository(FarmStockContainerSnapshot)
    private readonly containerRepo: Repository<FarmStockContainerSnapshot>,
    @InjectRepository(FarmStockBatchSnapshot)
    private readonly batchRepo: Repository<FarmStockBatchSnapshot>,
  ) {}

  async listInventory(
    tenantId: string,
    filter: FarmStockInventoryFilterInput = {},
  ): Promise<FarmStockInventoryConnection> {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 100);

    const qb = this.containerRepo.createQueryBuilder('container')
      .where('container.tenantId = :tenantId', { tenantId });

    if (filter.containerSources?.length) {
      qb.andWhere('container.containerSource IN (:...containerSources)', {
        containerSources: filter.containerSources,
      });
    }
    if (filter.departmentId) {
      qb.andWhere('container.departmentId = :departmentId', { departmentId: filter.departmentId });
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
      qb.andWhere('container.hasActiveBatch = :hasActiveBatch', { hasActiveBatch: filter.hasActiveBatch });
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
    const batches = containerIds.length
      ? await this.batchRepo.find({
          where: { tenantId, containerId: In(containerIds) },
          order: { batchNumber: 'ASC' },
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

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
