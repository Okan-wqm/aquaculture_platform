/**
 * ListStorageInventoryByCursor Query Handler
 *
 * First resolver adoption of the phase 5.1 cursor-pagination stack.
 * Delegates the tuple-WHERE / DESC-DESC ORDER BY / first+1 boilerplate
 * to `paginateCursor`, so the handler itself is a ~10-line config:
 * tenantId scope + two optional equality filters.
 *
 * Kept deliberately narrow — the old offset handler stays in place
 * for the deprecation window, and this one never grows beyond the
 * primitive's contract. A filter that needs a non-equality predicate
 * (range, IN, JSONB path) builds its own QueryBuilder and hands rows
 * to `buildCursorResponse` directly.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { paginateCursor, CursorPaginatedResponse } from '@aquaculture/backend-common/pagination';

import { ListStorageInventoryByCursorQuery } from '../queries/list-storage-inventory-by-cursor.query';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';

@QueryHandler(ListStorageInventoryByCursorQuery)
export class ListStorageInventoryByCursorHandler
  implements
    IQueryHandler<
      ListStorageInventoryByCursorQuery,
      CursorPaginatedResponse<StorageInventory>
    >
{
  constructor(
    @InjectRepository(StorageInventory)
    private readonly inventoryRepository: Repository<StorageInventory>,
  ) {}

  async execute(
    query: ListStorageInventoryByCursorQuery,
  ): Promise<CursorPaginatedResponse<StorageInventory>> {
    const { tenantId, locationId, itemType, input } = query;

    return paginateCursor(this.inventoryRepository, {
      input,
      tenantId,
      where: {
        ...(locationId !== undefined && { storageLocationId: locationId }),
        ...(itemType !== undefined && { itemType: itemType as StorageItemType }),
      },
    });
  }
}
