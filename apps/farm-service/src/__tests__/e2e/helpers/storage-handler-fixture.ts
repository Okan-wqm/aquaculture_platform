/**
 * Storage command handlers wired against a real DataSource, for real-Postgres
 * e2e suites.
 *
 * WHY a shared helper: a handler whose constructor declares `Repository<T>`
 * parameters (production injects them with `@InjectRepository`) can only be
 * driven against a real database by handing it real repositories, and the
 * raw repository accessor is confined to `__tests__/e2e/helpers/` by the
 * banned-construct gate. Building the handler here keeps that call in one
 * place instead of copying it into every suite.
 *
 * WHAT: `TransferStockHandler` exactly as production constructs it — its own
 * repositories, the DataSource it opens its transaction on, and the real
 * `SiteAuthorizationService`.
 */
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { DataSource } from 'typeorm';

import { StockMovement } from '../../../storage/entities/stock-movement.entity';
import { StorageInventory } from '../../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../../storage/entities/storage-location.entity';
import { TransferStockHandler } from '../../../storage/handlers/transfer-stock.handler';

/** The `transferStock` mutation's handler over a real database. */
export function createTransferStockHandler(dataSource: DataSource): TransferStockHandler {
  return new TransferStockHandler(
    dataSource.getRepository(StorageLocation),
    dataSource.getRepository(StorageInventory),
    dataSource.getRepository(StockMovement),
    dataSource,
    new SiteAuthorizationService(),
  );
}
