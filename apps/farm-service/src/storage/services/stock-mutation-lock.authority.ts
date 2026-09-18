/**
 * StockMutationLockAuthority — the ONE lock protocol every physical-stock
 * writer takes before it reads anything it is about to mutate.
 *
 * ## Why row locks were not enough
 *
 * W2's allocator locks its FEFO candidate rows with `FOR UPDATE`. That is
 * correct for rows that EXIST, and it is exactly the case it cannot cover:
 * a `RETURN`/`IN` into a `(tenant, location, itemType, itemId, lot)` bucket
 * whose projection row has not been created yet locks nothing at all, because
 * there is no tuple to lock. Two concurrent receipts of the same un-lotted feed
 * both read "no row", both `INSERT`, and the physical key ends up split across
 * two rows — the FARM-CRITICAL-240 shape, reached from the write side instead
 * of the historical-data side. The unique index catches the second writer with
 * a raw 23505 AFTER the transaction has done its other work.
 *
 * A PostgreSQL transaction-scoped advisory lock has no such gap: the key is a
 * string, not a tuple, so it exists whether or not the row does.
 *
 * ## Why the keys are sorted
 *
 * A transfer touches two items; a multi-line receipt touches N. Acquiring in
 * caller order lets T1 (A then B) and T2 (B then A) build an ABBA wait cycle
 * and deadlock. Sorting the key set makes every writer walk the same total
 * order, so a cycle cannot be constructed — the same reasoning FARM-MEDIUM-275
 * applied to the day-plan locks, applied here to stock.
 *
 * Mechanism ported from the 2026-08-16 farm-stock-mutation worktree
 * (`origin/wip/codex-farm-stock-mutation-20260816`).
 *
 * @module Storage/Services
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { StorageItemType } from '../entities/storage-inventory.entity';

/** Namespaced so an unrelated advisory-lock user cannot collide with stock. */
const LOCK_DOMAIN = 'aquaculture.stock-item/v1';
const IDEMPOTENCY_LOCK_DOMAIN = 'aquaculture.stock-idempotency/v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** The physical bucket a mutation serializes on. */
export interface StockMutationTarget {
  readonly itemType: StorageItemType;
  readonly itemId: string;
}

/**
 * Canonical lock key for one physical stock bucket. Lower-cased so two spellings
 * of the same UUID cannot take two different locks.
 */
export function stockMutationLockKey(tenantId: string, target: StockMutationTarget): string {
  if (!UUID.test(tenantId) || !UUID.test(target.itemId)) {
    throw new BadRequestException('Stock mutation tenant and item identities must be UUIDs');
  }
  if (!Object.values(StorageItemType).includes(target.itemType)) {
    throw new BadRequestException(`Unsupported stock item type: ${String(target.itemType)}`);
  }
  return `${LOCK_DOMAIN}:${tenantId.toLowerCase()}:${target.itemType}:${target.itemId.toLowerCase()}`;
}

/** Canonical lock key for one tenant-scoped idempotency key. */
export function stockIdempotencyLockKey(tenantId: string, idempotencyKey: string): string {
  if (!UUID.test(tenantId)) {
    throw new BadRequestException('Stock mutation tenant identity must be a UUID');
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 128) {
    throw new BadRequestException('Stock mutation idempotency key must be 1..128 characters');
  }
  return `${IDEMPOTENCY_LOCK_DOMAIN}:${tenantId.toLowerCase()}:${idempotencyKey}`;
}

@Injectable()
export class StockMutationLockAuthority {
  /**
   * Serialize the caller's transaction on every physical bucket it will touch.
   * Keys are de-duplicated and sorted, so no two callers can order them
   * differently.
   */
  async acquire(
    manager: EntityManager,
    tenantId: string,
    targets: readonly StockMutationTarget[],
  ): Promise<void> {
    const keys = [
      ...new Set(targets.map((target) => stockMutationLockKey(tenantId, target))),
    ].sort();
    for (const key of keys) {
      await this.acquireKey(manager, key);
    }
  }

  /**
   * Serialize the tenant's idempotency namespace for one key.
   *
   * Item locks alone do not cover it: two concurrent requests may reuse one
   * idempotency key for DIFFERENT items, which take different item locks and
   * therefore never meet. This fence makes the unique receipt readable before
   * either writer mutates a projection, so the loser sees a hit instead of
   * colliding on the unique index mid-transaction.
   */
  async acquireIdempotency(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.acquireKey(manager, stockIdempotencyLockKey(tenantId, idempotencyKey));
  }

  private async acquireKey(manager: EntityManager, key: string): Promise<void> {
    if (manager.queryRunner?.isTransactionActive !== true) {
      // A lock that is not transaction-scoped is not a lock: `pg_advisory_xact_lock`
      // releases at COMMIT/ROLLBACK, so outside a transaction it would be taken and
      // dropped in the same statement and protect nothing.
      throw new Error('Stock mutation requires an active caller-owned transaction');
    }
    await manager.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      [key],
    );
  }
}
