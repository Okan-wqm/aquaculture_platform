import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GetStorageInventoryQuery } from '../queries/get-storage-inventory.query';
import { StorageInventory } from '../entities/storage-inventory.entity';

/** Default page size to prevent unbounded result sets on large warehouses */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

@QueryHandler(GetStorageInventoryQuery)
export class GetStorageInventoryHandler implements IQueryHandler<GetStorageInventoryQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetStorageInventoryQuery): Promise<StorageInventory[]> {
    const { tenantId, locationId, itemType, limit, offset } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager.createQueryBuilder(StorageInventory, 'inv');
      qb.where('inv.tenantId = :tenantId', { tenantId });

      if (locationId) {
        qb.andWhere('inv.storageLocationId = :locationId', { locationId });
      }

      if (itemType) {
        qb.andWhere('inv.itemType = :itemType', { itemType });
      }

      qb.orderBy('inv.createdAt', 'DESC');

      // F-8: Apply pagination to prevent full table scan on large inventories.
      // Default limit of 100 matches typical warehouse UI page size; callers
      // can request up to MAX_LIMIT (500) for bulk export use cases.
      const take = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const skip = offset ?? 0;
      qb.take(take).skip(skip);

      return qb.getMany();
    });
  }
}
