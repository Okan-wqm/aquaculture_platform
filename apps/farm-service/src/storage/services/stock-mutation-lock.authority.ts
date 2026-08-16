import { BadRequestException, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { StorageItemType } from '../entities/storage-inventory.entity';

const LOCK_DOMAIN = 'aquaculture.stock-item/v1';
const IDEMPOTENCY_LOCK_DOMAIN = 'aquaculture.stock-idempotency/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface StockMutationTargetV1 {
  readonly itemType: StorageItemType;
  readonly itemId: string;
}

export function stockMutationKeyV1(tenantId: string, target: StockMutationTargetV1): string {
  if (!UUID.test(tenantId) || !UUID.test(target.itemId)) {
    throw new BadRequestException('Stock mutation tenant and item identities must be UUIDs');
  }
  if (!Object.values(StorageItemType).includes(target.itemType)) {
    throw new BadRequestException(`Unsupported stock item type: ${String(target.itemType)}`);
  }
  return `${LOCK_DOMAIN}:${tenantId.toLowerCase()}:${target.itemType}:${target.itemId.toLowerCase()}`;
}

export function stockIdempotencyKeyV1(tenantId: string, idempotencyKey: string): string {
  if (!UUID.test(tenantId)) {
    throw new BadRequestException('Stock mutation tenant identity must be a UUID');
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 64) {
    throw new BadRequestException('Stock mutation idempotency key must be 1..64 characters');
  }
  return `${IDEMPOTENCY_LOCK_DOMAIN}:${tenantId.toLowerCase()}:${idempotencyKey}`;
}

/**
 * PostgreSQL transaction lock authority for physical stock.
 *
 * Row locks cannot protect a physical key that does not exist yet. Every
 * writer therefore serializes on `(tenant,itemType,itemId)` before reading a
 * projection, an idempotency receipt, or an allocation pool. Multi-item calls
 * acquire sorted keys, making opposite transfer/order directions incapable of
 * constructing an ABBA wait cycle.
 */
@Injectable()
export class StockMutationLockAuthority {
  async acquire(
    manager: EntityManager,
    tenantId: string,
    targets: readonly StockMutationTargetV1[],
  ): Promise<void> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('Stock mutation requires an active caller-owned transaction');
    }
    const keys = [...new Set(targets.map((target) => stockMutationKeyV1(tenantId, target)))].sort();
    for (const key of keys) {
      await this.acquireKey(manager, key);
    }
  }

  /**
   * Serializes the tenant-global idempotency namespace. Item locks alone do
   * not protect two concurrent requests that reuse one key for different
   * items; this fence makes the unique receipt readable before either writer
   * mutates a projection.
   */
  async acquireIdempotency(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<void> {
    this.assertActiveTransaction(manager);
    await this.acquireKey(manager, stockIdempotencyKeyV1(tenantId, idempotencyKey));
  }

  private assertActiveTransaction(manager: EntityManager): void {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('Stock mutation requires an active caller-owned transaction');
    }
  }

  private async acquireKey(manager: EntityManager, key: string): Promise<void> {
    this.assertActiveTransaction(manager);
    await manager.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      [key],
    );
  }
}
