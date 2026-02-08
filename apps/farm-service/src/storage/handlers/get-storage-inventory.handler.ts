import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetStorageInventoryQuery } from '../queries/get-storage-inventory.query';
import { StorageInventory } from '../entities/storage-inventory.entity';

@QueryHandler(GetStorageInventoryQuery)
export class GetStorageInventoryHandler implements IQueryHandler<GetStorageInventoryQuery> {
  constructor(
    @InjectRepository(StorageInventory)
    private readonly inventoryRepository: Repository<StorageInventory>,
  ) {}

  async execute(query: GetStorageInventoryQuery): Promise<StorageInventory[]> {
    const { tenantId, locationId, itemType } = query;

    const qb = this.inventoryRepository.createQueryBuilder('inv');
    qb.where('inv.tenantId = :tenantId', { tenantId });

    if (locationId) {
      qb.andWhere('inv.storageLocationId = :locationId', { locationId });
    }

    if (itemType) {
      qb.andWhere('inv.itemType = :itemType', { itemType });
    }

    qb.orderBy('inv.createdAt', 'DESC');

    return qb.getMany();
  }
}
