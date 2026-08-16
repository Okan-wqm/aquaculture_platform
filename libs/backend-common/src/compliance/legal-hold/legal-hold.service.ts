import { ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, EntityManager } from 'typeorm';

import { tenantManagerRepo } from '../../database';

import { LegalHoldEntity } from './legal-hold.entity';
import { HoldScope, LegalHoldActiveError, LegalHoldRecord } from './legal-hold.types';

/**
 * Optional Redis abstraction — service runs WITHOUT Redis in dev/test
 * (cache-miss falls back to DB query). Production injects a real client
 * via the standard REDIS_CLIENT token from libs/backend-common/redis.
 *
 * Local interface so this module does not import the redis package
 * directly — keeps the dependency graph cleaner and the entity / type
 * exports lean. Real signatures: `Redis.get`, `Redis.setex` (or `set` +
 * `EX`), `Redis.del`.
 */
export interface LegalHoldCacheClient {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Token consumed via @Optional() @Inject(LEGAL_HOLD_CACHE_CLIENT). The
 * canonical Redis client (libs/backend-common/redis) implements the
 * three methods this service needs; services wiring LegalHoldModule
 * pass `{ provide: LEGAL_HOLD_CACHE_CLIENT, useExisting: REDIS_CLIENT }`
 * to bridge the two tokens.
 */
export const LEGAL_HOLD_CACHE_CLIENT = Symbol('LEGAL_HOLD_CACHE_CLIENT');

const ACTIVE_TTL_SECONDS = 300; // 5 min — matches the hold-state-changes-rarely access pattern

@Injectable()
export class LegalHoldService {
  private readonly logger = new Logger(LegalHoldService.name);

  constructor(
    @InjectRepository(LegalHoldEntity)
    private readonly repo: Repository<LegalHoldEntity>,
    @Optional()
    @Inject(LEGAL_HOLD_CACHE_CLIENT)
    private readonly cache?: LegalHoldCacheClient,
  ) {}

  /**
   * Check whether the (tenant, scope, resource) tuple has an active hold.
   *
   * # Cache semantics
   *
   * Hot-path readers (every destructive operation across the platform)
   * call this method. A 5-minute Redis cache absorbs the load. On
   * cache miss the DB row is fetched and the result is cached. Hold
   * activate() and release() invalidate the matching keys so cache
   * coherence is bounded by the longer of (network latency, write-through).
   *
   * # Fail-CLOSED on Redis unavailability
   *
   * If the Redis call THROWS (cluster down, network partition), this
   * method does NOT swallow the error and proceed to DB — that would
   * silently degrade the consistency window. Instead the error
   * propagates so the caller can decide. In practice destructive
   * operations should treat any error here as "hold may be active" and
   * abort — the alternative (treat as no-hold) would let a transient
   * Redis blip authorise an erasure that overrides legal hold.
   */
  async isUnderHold(tenantId: string, scope: HoldScope, resourceId?: string): Promise<boolean> {
    const cacheKey = this.cacheKey(tenantId, scope, resourceId);
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached === '1') return true;
      if (cached === '0') return false;
    }

    const row = await this.repo.findOne({
      where: {
        tenantId,
        scope,
        resourceId: resourceId ?? IsNull(),
        releasedAt: IsNull(),
      },
    });
    const onHold = !!row;
    if (this.cache) {
      await this.cache.setex(cacheKey, ACTIVE_TTL_SECONDS, onHold ? '1' : '0');
    }
    return onHold;
  }

  /**
   * Asserting helper — throws LegalHoldActiveError if blocked. The
   * destructive-paths invariant (W2.7) requires this single line to
   * appear before every DROP/DELETE/erase callsite, so the test gate
   * detects unguarded paths via grep. The error carries enough context
   * for the operator to find the blocking hold in one query.
   */
  async assertNoHold(tenantId: string, scope: HoldScope, resourceId?: string): Promise<void> {
    if (await this.isUnderHold(tenantId, scope, resourceId)) {
      const blockingHold = await this.repo.findOne({
        where: {
          tenantId,
          scope,
          resourceId: resourceId ?? IsNull(),
          releasedAt: IsNull(),
        },
      });
      throw new LegalHoldActiveError({
        tenantId,
        scope,
        resourceId: resourceId ?? null,
        legalMatterId: blockingHold?.legalMatterId ?? 'unknown',
      });
    }
  }

  /**
   * Activate a legal hold.
   *
   * @throws ForbiddenException when legalMatterId is missing —
   *   GDPR proportionality requires every hold to reference a matter.
   * @throws Error (DB unique-constraint) when a hold already exists for
   *   the (tenantId, scope, resourceId) tuple. Caller MUST handle this
   *   case (typically: surface the existing hold's matter ID + tell the
   *   operator the hold is already in place).
   */
  async activate(args: {
    tenantId: string;
    scope: HoldScope;
    resourceId?: string;
    reason: string;
    legalMatterId: string;
    appliedBy: string;
    manager?: EntityManager;
  }): Promise<LegalHoldRecord> {
    if (!args.legalMatterId) {
      throw new ForbiddenException(
        'legalMatterId is required: a legal hold must reference a specific legal matter (GDPR proportionality).',
      );
    }

    // WHY: tenantManagerRepo is the canonical tenant-scoped wrapper —
    // every read/write through the returned repo carries `tenantId =
    // args.tenantId` automatically, so this manager-bound path cannot
    // accidentally leak into another tenant's hold rows.
    const repo = args.manager
      ? tenantManagerRepo(args.manager, LegalHoldEntity, args.tenantId)
      : this.repo;

    const row = repo.create({
      tenantId: args.tenantId,
      scope: args.scope,
      resourceId: args.resourceId ?? null,
      reason: args.reason,
      legalMatterId: args.legalMatterId,
      appliedBy: args.appliedBy,
      releasedBy: null,
      releasedAt: null,
      releaseReason: null,
    });
    const saved = await repo.save(row);
    await this.invalidateCache(args.tenantId, args.scope, args.resourceId);
    this.logger.log(
      `Legal hold activated: tenantId=${args.tenantId} scope=${args.scope} resourceId=${args.resourceId ?? '*'} matter=${args.legalMatterId}`,
    );
    return this.toRecord(saved);
  }

  /**
   * Release a legal hold.
   *
   * # Dual-control invariant (LEGAL-MEDIUM-002)
   *
   * Hold release is a privileged operation. The caller MUST verify that
   * (a) a second approver has signed off in
   * compliance.legal_hold_release_approvals AND (b) the requesting
   * operator has MFA-step-up tokens within the last 5 minutes. Those
   * checks live at the controller boundary (admin-api), not here —
   * this method enforces the storage-side write-once-released invariant
   * and the cache-invalidation contract.
   */
  async release(args: {
    holdId: string;
    tenantId: string;
    releasedBy: string;
    releaseReason: string;
    manager?: EntityManager;
  }): Promise<LegalHoldRecord> {
    // WHY: tenantManagerRepo wrapper auto-pins tenantId on every
    // read/write through the returned repo, so the release path cannot
    // accidentally release a hold from a different tenant via id collision.
    const repo = args.manager
      ? tenantManagerRepo(args.manager, LegalHoldEntity, args.tenantId)
      : this.repo;
    const hold = await repo.findOne({
      where: { id: args.holdId, tenantId: args.tenantId },
    });
    if (!hold) {
      throw new ForbiddenException(
        `Legal hold ${args.holdId} not found in tenant ${args.tenantId}`,
      );
    }
    if (hold.releasedAt !== null) {
      throw new ForbiddenException(
        `Legal hold ${args.holdId} is already released (released by ${hold.releasedBy ?? 'unknown'} at ${hold.releasedAt.toISOString()})`,
      );
    }
    hold.releasedBy = args.releasedBy;
    hold.releasedAt = new Date();
    hold.releaseReason = args.releaseReason;
    const saved = await repo.save(hold);
    await this.invalidateCache(hold.tenantId, hold.scope, hold.resourceId ?? undefined);
    this.logger.log(
      `Legal hold released: id=${saved.id} tenantId=${saved.tenantId} scope=${saved.scope} releasedBy=${args.releasedBy}`,
    );
    return this.toRecord(saved);
  }

  /**
   * List all active holds for a tenant. Used by the admin-api UI and by
   * the legal-team's "matter closeout" workflow.
   */
  async listActive(tenantId: string): Promise<LegalHoldRecord[]> {
    const rows = await this.repo.find({
      where: { tenantId, releasedAt: IsNull() },
      order: { appliedAt: 'DESC' },
    });
    return rows.map((r) => this.toRecord(r));
  }

  private async invalidateCache(
    tenantId: string,
    scope: HoldScope,
    resourceId: string | null | undefined,
  ): Promise<void> {
    if (!this.cache) return;
    await this.cache.del(this.cacheKey(tenantId, scope, resourceId ?? undefined));
  }

  private cacheKey(tenantId: string, scope: HoldScope, resourceId: string | undefined): string {
    return `legal-hold:${tenantId}:${scope}:${resourceId ?? '*'}`;
  }

  private toRecord(row: LegalHoldEntity): LegalHoldRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      scope: row.scope,
      resourceId: row.resourceId,
      reason: row.reason,
      legalMatterId: row.legalMatterId,
      appliedBy: row.appliedBy,
      appliedAtIso: row.appliedAt.toISOString(),
      releasedBy: row.releasedBy,
      releasedAtIso: row.releasedAt ? row.releasedAt.toISOString() : null,
      releaseReason: row.releaseReason,
    };
  }
}
