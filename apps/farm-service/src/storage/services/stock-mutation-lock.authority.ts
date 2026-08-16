import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  readTenantMutationSession,
  type MutationInstantV1,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { StorageItemType } from '../entities/storage-inventory.entity';

const STOCK_MUTATION_LOCK_DOMAIN_V1 = 'aquaculture.stock-mutation-item/v1';
const STOCK_MUTATION_LOCK_SQL_V1 =
  'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))';
const UUID_V4_COMPATIBLE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ITEM_TYPES = new Set<string>(Object.values(StorageItemType));

export interface StockMutationTargetV1 {
  readonly itemType: StorageItemType;
  readonly itemId: string;
}

export interface StockMutationScopeV1 {
  readonly manager: EntityManager;
  readonly tenantId: string;
  readMutationInstant(): Promise<Date>;
}

interface StockMutationSessionStateV1 {
  readonly manager: EntityManager;
  readonly tenantId: string;
  readonly lockedKeys: Set<string>;
  greatestLockedKey?: string;
  mutationInstant?: Promise<MutationInstantV1>;
}

export class StockMutationLockOrderError extends Error {
  constructor(previousKey: string, requestedKey: string) {
    super(`Stock mutation lock order violation: ${requestedKey} sorts before ${previousKey}`);
    this.name = 'StockMutationLockOrderError';
  }
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Canonical transaction-lock identity for every projection row belonging to
 * one stock item. Location and lot are intentionally absent: a transfer in
 * either direction and an insert into a previously absent physical key must
 * serialize on the same item authority before any row lock or idempotency read.
 */
export function canonicalStockMutationKeyV1(
  tenantId: string,
  target: StockMutationTargetV1,
): string {
  if (!UUID_V4_COMPATIBLE.test(tenantId)) {
    throw new TypeError('Stock mutation tenantId must be a UUID');
  }
  if (!ITEM_TYPES.has(target.itemType)) {
    throw new TypeError(`Unsupported stock item type: ${String(target.itemType)}`);
  }
  if (!UUID_V4_COMPATIBLE.test(target.itemId)) {
    throw new TypeError('Stock mutation itemId must be a UUID');
  }
  return `${STOCK_MUTATION_LOCK_DOMAIN_V1}:${tenantId.toLowerCase()}:${target.itemType}:${target.itemId.toLowerCase()}`;
}

export function compareStockMutationTargetsV1(
  tenantId: string,
  left: StockMutationTargetV1,
  right: StockMutationTargetV1,
): number {
  return compareCanonicalKeys(
    canonicalStockMutationKeyV1(tenantId, left),
    canonicalStockMutationKeyV1(tenantId, right),
  );
}

/**
 * Sole stock concurrency adapter.
 *
 * PostgreSQL row locks cannot protect an absent inventory key. This authority
 * therefore acquires one transaction-scoped advisory lock for the complete
 * `(tenant, itemType, itemId)` projection before any stock read or write. The
 * same domain also makes transfer direction irrelevant and rejects descending
 * multi-item acquisition before PostgreSQL can wait, structurally excluding
 * ABBA cycles. The opaque tenant mutation session proves both transaction and
 * tenant ownership; callers cannot supply an arbitrary EntityManager.
 */
@Injectable()
export class StockMutationLockAuthority {
  private readonly states = new WeakMap<TenantMutationSession, StockMutationSessionStateV1>();

  async acquire(
    session: TenantMutationSession,
    expectedTenantId: string,
    target: StockMutationTargetV1,
  ): Promise<StockMutationScopeV1> {
    const verified = readTenantMutationSession(session, 'farm');
    if (verified.tenantId.toLowerCase() !== expectedTenantId.toLowerCase()) {
      throw new Error('Stock mutation tenant does not match the opaque transaction session');
    }

    const key = canonicalStockMutationKeyV1(verified.tenantId, target);
    let state = this.states.get(session);
    if (!state) {
      state = {
        manager: verified.manager,
        tenantId: verified.tenantId,
        lockedKeys: new Set<string>(),
      };
      this.states.set(session, state);
    } else if (state.manager !== verified.manager || state.tenantId !== verified.tenantId) {
      throw new Error('Tenant mutation session identity changed during stock mutation');
    }

    if (!state.lockedKeys.has(key)) {
      if (
        state.greatestLockedKey !== undefined &&
        compareCanonicalKeys(key, state.greatestLockedKey) < 0
      ) {
        throw new StockMutationLockOrderError(state.greatestLockedKey, key);
      }
      await state.manager.query(STOCK_MUTATION_LOCK_SQL_V1, [key]);
      state.lockedKeys.add(key);
      state.greatestLockedKey = key;
    }

    return Object.freeze({
      manager: state.manager,
      tenantId: state.tenantId,
      readMutationInstant: async (): Promise<Date> => {
        state!.mutationInstant ??= readTenantMutationInstantV1(session, 'farm');
        return mutationInstantDateV1(await state!.mutationInstant);
      },
    });
  }
}
