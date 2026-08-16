import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { acquireTenantAdvisoryLock } from './legal-hold.advisory-lock';

interface ActiveLegalHold {
  readonly id: string;
  readonly channelId: string | null;
}

interface ActiveLegalHoldSnapshot {
  readonly tenantWideHoldIds: readonly string[];
  readonly heldChannelIds: readonly string[];
  readonly holds: readonly ActiveLegalHold[];
}

export interface ChannelMutationTarget<TTarget> {
  readonly channelId: string;
  readonly target: TTarget;
}

export interface AuthorizedChannelMutation<TTarget> {
  readonly manager: EntityManager;
  readonly target: TTarget;
}

export interface AuthorizedUserMutation {
  readonly manager: EntityManager;
  /**
   * Every active channel-scoped hold in the locked snapshot. Callers must use
   * this list as a SQL exclusion as well as relying on the current user-scope
   * check, so a concurrently-created user row cannot enter a held channel.
   */
  readonly heldChannelIds: readonly string[];
}

export interface AuthorizedPartitionedTenantMutation {
  readonly manager: EntityManager;
  /** Exact channel exclusions protected by the tenant lock until commit. */
  readonly heldChannelIds: readonly string[];
}

export type LegalHoldBlockReason = 'TENANT_WIDE_HOLD' | 'CHANNEL_HOLD' | 'USER_CHANNEL_HOLD';

/**
 * Typed stop signal emitted before a destructive callback can run.
 */
export class LegalHoldDestructiveMutationBlocked extends ForbiddenException {
  constructor(
    public readonly tenantId: string,
    public readonly reason: LegalHoldBlockReason,
    public readonly holdIds: readonly string[],
  ) {
    super(`Destructive messaging mutation blocked by active legal hold (${reason})`);
  }
}

/**
 * Single mutation boundary for every messaging write that can destroy held
 * evidence.
 *
 * The boundary owns the complete ordering contract:
 *
 * 1. open and tenant-pin one database transaction;
 * 2. acquire the same tenant advisory lock used by hold activation/release;
 * 3. read an authoritative `isActive = true` hold snapshot on that transaction;
 * 4. invoke the destructive callback only with a typed authorization context;
 * 5. retain the lock until the transaction commits or rolls back.
 *
 * `expiresAt` is deliberately absent from the snapshot predicate. It is a
 * review deadline, not an automatic release authority; only an explicit,
 * governed transition may set `isActive = false`.
 */
@Injectable()
export class LegalHoldDestructiveMutationAuthority {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolve a channel-bound target after the tenant lock is held, authorize its
   * exact channel, then mutate it in the same transaction.
   */
  async runChannelMutation<TTarget, TResult>(
    tenantId: string,
    resolveTarget: (manager: EntityManager) => Promise<ChannelMutationTarget<TTarget>>,
    mutate: (authorization: AuthorizedChannelMutation<TTarget>) => Promise<TResult>,
  ): Promise<TResult> {
    return this.runLocked(tenantId, async (manager) => {
      const resolved = await resolveTarget(manager);
      if (resolved.channelId.length === 0) {
        throw new Error('Channel-scoped destructive mutation resolved an empty channelId');
      }

      const snapshot = await this.loadActiveSnapshot(manager, tenantId);
      this.assertChannelClear(tenantId, resolved.channelId, snapshot);

      return mutate({ manager, target: resolved.target });
    });
  }

  /**
   * Authorize a user-wide erasure against every channel in which the user has a
   * message or membership. A single in-scope hold blocks the whole erasure.
   */
  async runUserMutation<TResult>(
    tenantId: string,
    userId: string,
    mutate: (authorization: AuthorizedUserMutation) => Promise<TResult>,
  ): Promise<TResult> {
    return this.runLocked(tenantId, async (manager) => {
      const snapshot = await this.loadActiveSnapshot(manager, tenantId);
      const userChannelIds = await this.loadUserChannelIds(manager, userId);
      this.assertUserScopeClear(tenantId, userChannelIds, snapshot);

      return mutate({ manager, heldChannelIds: snapshot.heldChannelIds });
    });
  }

  /**
   * Authorize a tenant-wide mutation that can safely partition its SQL around
   * channel-scoped holds. A tenant-wide hold blocks the callback; channel holds
   * are supplied as mandatory exclusions.
   */
  async runPartitionedTenantMutation<TResult>(
    tenantId: string,
    mutate: (authorization: AuthorizedPartitionedTenantMutation) => Promise<TResult>,
  ): Promise<TResult> {
    return this.runLocked(tenantId, async (manager) => {
      const snapshot = await this.loadActiveSnapshot(manager, tenantId);
      this.assertNoTenantWideHold(tenantId, snapshot);
      return mutate({ manager, heldChannelIds: snapshot.heldChannelIds });
    });
  }

  private async runLocked<TResult>(
    tenantId: string,
    work: (manager: EntityManager) => Promise<TResult>,
  ): Promise<TResult> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      // This is the first domain operation after the shared tenant-boundary
      // preamble. Hold mutations contend on this exact key.
      await acquireTenantAdvisoryLock(queryRunner, tenantId);
      return work(queryRunner.manager);
    });
  }

  private async loadActiveSnapshot(
    manager: EntityManager,
    tenantId: string,
  ): Promise<ActiveLegalHoldSnapshot> {
    const result: unknown = await manager.query(
      `SELECT id, "channelId"
       FROM legal_holds
       WHERE "tenantId" = $1::uuid AND "isActive" = true
       ORDER BY "channelId" NULLS FIRST, id`,
      [tenantId],
    );
    const holds = parseActiveLegalHolds(result);
    const tenantWideHoldIds = holds
      .filter((hold) => hold.channelId === null)
      .map((hold) => hold.id);
    const heldChannelIds = [
      ...new Set(holds.flatMap((hold) => (hold.channelId === null ? [] : [hold.channelId]))),
    ].sort();

    return Object.freeze({
      tenantWideHoldIds: Object.freeze(tenantWideHoldIds),
      heldChannelIds: Object.freeze(heldChannelIds),
      holds: Object.freeze(holds),
    });
  }

  private async loadUserChannelIds(
    manager: EntityManager,
    userId: string,
  ): Promise<readonly string[]> {
    const result: unknown = await manager.query(
      `SELECT DISTINCT scope."channelId"
       FROM (
         SELECT "channelId" FROM messages WHERE "senderId" = $1::uuid
         UNION
         SELECT "channelId" FROM channel_members WHERE "userId" = $1::uuid
       ) AS scope
       ORDER BY scope."channelId"`,
      [userId],
    );
    return Object.freeze(parseChannelRows(result));
  }

  private assertNoTenantWideHold(tenantId: string, snapshot: ActiveLegalHoldSnapshot): void {
    if (snapshot.tenantWideHoldIds.length > 0) {
      throw new LegalHoldDestructiveMutationBlocked(
        tenantId,
        'TENANT_WIDE_HOLD',
        snapshot.tenantWideHoldIds,
      );
    }
  }

  private assertChannelClear(
    tenantId: string,
    channelId: string,
    snapshot: ActiveLegalHoldSnapshot,
  ): void {
    this.assertNoTenantWideHold(tenantId, snapshot);
    const channelHoldIds = snapshot.holds
      .filter((hold) => hold.channelId === channelId)
      .map((hold) => hold.id);
    if (channelHoldIds.length > 0) {
      throw new LegalHoldDestructiveMutationBlocked(
        tenantId,
        'CHANNEL_HOLD',
        Object.freeze(channelHoldIds),
      );
    }
  }

  private assertUserScopeClear(
    tenantId: string,
    userChannelIds: readonly string[],
    snapshot: ActiveLegalHoldSnapshot,
  ): void {
    this.assertNoTenantWideHold(tenantId, snapshot);
    const userChannels = new Set(userChannelIds);
    const holdIds = snapshot.holds
      .filter((hold) => hold.channelId !== null && userChannels.has(hold.channelId))
      .map((hold) => hold.id);
    if (holdIds.length > 0) {
      throw new LegalHoldDestructiveMutationBlocked(
        tenantId,
        'USER_CHANNEL_HOLD',
        Object.freeze(holdIds),
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseActiveLegalHolds(value: unknown): ActiveLegalHold[] {
  if (!Array.isArray(value)) {
    throw new Error('Legal-hold registry returned a non-array snapshot');
  }

  return value.map((row) => {
    if (
      !isRecord(row) ||
      typeof row['id'] !== 'string' ||
      (row['channelId'] !== null && typeof row['channelId'] !== 'string')
    ) {
      throw new Error('Legal-hold registry returned an invalid snapshot row');
    }
    return Object.freeze({ id: row['id'], channelId: row['channelId'] });
  });
}

function parseChannelRows(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('User legal-hold scope query returned a non-array result');
  }

  return value.map((row) => {
    if (!isRecord(row) || typeof row['channelId'] !== 'string') {
      throw new Error('User legal-hold scope query returned an invalid channel row');
    }
    return row['channelId'];
  });
}
