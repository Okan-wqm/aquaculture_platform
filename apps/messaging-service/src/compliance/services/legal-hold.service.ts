import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, IsNull, EntityManager, FindOptionsWhere } from 'typeorm';
import Redis from 'ioredis';

import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { LegalHold } from '../entities/legal-hold.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/**
 * Thrown when the legal-hold registry cannot be queried within
 * the configured deadline (LEGAL-MEDIUM-001 cure).
 *
 * # Why a distinct error class
 *
 * Callers (retention sweeps, GDPR cascades, partition drops)
 * MUST treat this as "held" — the spec's fail-CLOSED posture
 * means destructive ops abort when the hold registry is
 * unavailable. A generic Error would let a careless catch
 * branch convert "registry unreachable" into "no hold" by
 * accident; the distinct name makes the failure mode visible
 * at every callsite.
 *
 * The agent spec ties this to a 500 ms deadline: registry-
 * unavailable longer than that produces this error. Operators
 * see the class in stack traces + audit logs and know
 * "the destructive op did NOT proceed because we couldn't
 * confirm hold state."
 */
export class LegalHoldCheckUnavailable extends Error {
  constructor(
    message: string,
    public readonly tenantId: string,
    public readonly channelId: string | null,
  ) {
    super(message);
    this.name = 'LegalHoldCheckUnavailable';
  }
}

/**
 * Deadline (ms) for the registry query. Per the legal-hold-auditor
 * agent spec: "Fail-CLOSED: if registry lookup fails (DB error,
 * timeout > 500ms), action BLOCKED with LegalHoldCheckUnavailable
 * error".
 *
 * 500 ms is the spec-anchored value; operators should not lower
 * it (would falsely fail on healthy DB under load) and should
 * not raise it without a corresponding architecture change
 * (would let destructive ops sit blocked longer than the spec
 * permits).
 */
const LEGAL_HOLD_CHECK_DEADLINE_MS = 500;

/**
 * Half-open window (ms) for the cache-invalidation circuit breaker.
 * Once tripped by an invalidation failure, the breaker stays open
 * for this duration; after that, the next successful invalidation
 * (or read-through path) resets it.
 *
 * # Why 30 seconds
 *
 * Long enough that transient Redis blips (failover, reconfigure)
 * resolve before we keep paying the bypass cost; short enough that
 * a fixed Redis quickly returns to cached fast-path. The agent
 * spec mandates "0-TTL until Redis recovers" — this is the recovery
 * detection window.
 */
const LEGAL_HOLD_CACHE_BREAKER_RESET_MS = 30_000;

/**
 * Exposes legal-hold reads and invalidates their cache projection.
 *
 * When a legal hold is active, messages in scope (tenant-wide or channel-specific)
 * cannot be deleted by GDPR anonymise or retention cleanup.
 *
 * Both state mutations are deliberately absent from this surface: the
 * activation command handler and durable two-person release-operation service
 * own their respective transactional workflows.
 *
 * @see ADR-012 Phase 3 (Legal Hold Support)
 */
@Injectable()
export class LegalHoldService {
  private readonly logger = new Logger(LegalHoldService.name);

  /**
   * Process-local circuit breaker for cache invalidation (LEGAL-MEDIUM-001 cure).
   *
   * Tripped when invalidateLegalHoldProjection() catches a Redis error.
   * While tripped, isCacheDegraded() returns true → cache READERS
   * (when wired in Phase 9.4 platform-kernel migration) MUST treat
   * the cache as cold and re-query the DB. After the reset window
   * elapses, the next successful invalidation (or explicit
   * resetCacheBreaker() call by the cache reader) clears it.
   *
   * Why a process-local breaker, not a Redis-key heartbeat:
   *   The failure mode under question is "Redis itself unreachable".
   *   A Redis-key heartbeat would be unreachable for the same reason.
   *   A process-local boolean survives Redis outage and is checked
   *   on every read path.
   */
  private cacheBreakerOpenedAt: number | null = null;

  constructor(
    @InjectRepository(LegalHold)
    private readonly holdRepo: Repository<LegalHold>,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis?: Redis,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  /**
   * Returns true if cache invalidation has recently failed and
   * cache reads should bypass to the DB. Auto-resets after
   * LEGAL_HOLD_CACHE_BREAKER_RESET_MS once no further failures occur.
   */
  isCacheDegraded(): boolean {
    if (this.cacheBreakerOpenedAt === null) return false;
    const elapsed = Date.now() - this.cacheBreakerOpenedAt;
    if (elapsed > LEGAL_HOLD_CACHE_BREAKER_RESET_MS) {
      this.cacheBreakerOpenedAt = null;
      return false;
    }
    return true;
  }

  /**
   * Check whether a tenant or specific channel is under active legal hold.
   *
   * Used by deletion, anonymisation, and retention cleanup handlers.
   *
   * # Fail-CLOSED posture (LEGAL-MEDIUM-001 cure)
   *
   * Each registry query is wrapped in a 500 ms deadline race. If the
   * deadline expires (or the query rejects), this method THROWS
   * LegalHoldCheckUnavailable rather than returning false. Callers
   * MUST allow that throw to propagate up to the destructive op
   * (delete/anonymise/drop_chunks); a generic catch that converts
   * "registry unreachable" into "no hold" would defeat the
   * legal-hold guarantee.
   *
   * Why throw instead of return-true:
   *   - true means "hold present" — overloads the same return value
   *     with two different operational meanings (real hold vs.
   *     registry-down).
   *   - The distinct exception class makes the failure mode visible
   *     in stack traces, audit logs, and metrics; operators can
   *     alert on registry-down independently of legitimate holds.
   */
  async isUnderLegalHold(
    tenantId: string,
    channelId: string | null,
    manager?: EntityManager,
  ): Promise<boolean> {
    const deadline = <T>(p: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new LegalHoldCheckUnavailable(
              `Hold registry query exceeded ${LEGAL_HOLD_CHECK_DEADLINE_MS}ms deadline (tenant=${tenantId}, channel=${channelId ?? 'all'})`,
              tenantId,
              channelId,
            ),
          );
        }, LEGAL_HOLD_CHECK_DEADLINE_MS);
        // unref so the timer never holds the event loop open in tests
        timer?.unref?.();
      });
      return Promise.race([p, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };

    const findHold = (where: FindOptionsWhere<LegalHold>): Promise<LegalHold | null> => {
      if (manager) {
        return tenantManagerRepo(manager, LegalHold, tenantId).findOne({ where });
      }
      if (this.dataSource) {
        return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
          tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).findOne({ where }),
        );
      }
      return this.holdRepo.findOne({ where });
    };

    // Check tenant-wide hold first
    let tenantHold: LegalHold | null;
    try {
      tenantHold = await deadline(findHold({ tenantId, channelId: IsNull(), isActive: true }));
    } catch (err: unknown) {
      if (err instanceof LegalHoldCheckUnavailable) throw err;
      // Non-deadline DB errors are also fail-CLOSED per agent spec.
      const message = err instanceof Error ? err.message : String(err);
      throw new LegalHoldCheckUnavailable(
        `Hold registry query failed: ${message}`,
        tenantId,
        channelId,
      );
    }
    if (tenantHold) return true;

    // If a specific channel is requested, also check channel-level hold
    if (channelId) {
      let channelHold: LegalHold | null;
      try {
        channelHold = await deadline(findHold({ tenantId, channelId, isActive: true }));
      } catch (err: unknown) {
        if (err instanceof LegalHoldCheckUnavailable) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new LegalHoldCheckUnavailable(
          `Hold registry query failed: ${message}`,
          tenantId,
          channelId,
        );
      }
      if (channelHold) return true;
    }

    return false;
  }

  /**
   * Return IDs of all channels with an active channel-scoped legal hold.
   *
   * Used by tenant-wide retention cleanup to exclude held channels from DELETE.
   * O(1) query — returns only the channelId column, not full hold records.
   */
  async getHeldChannelIds(tenantId: string): Promise<string[]> {
    const holds = this.dataSource
      ? await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
          tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).find({
            where: { tenantId, isActive: true },
            select: ['channelId'],
          }),
        )
      : await this.holdRepo.find({
          where: { tenantId, isActive: true },
          select: ['channelId'],
        });

    return holds.filter((h) => h.channelId !== null).map((h) => h.channelId as string);
  }

  /**
   * Get all legal holds for a tenant (active and released).
   */
  async getHolds(tenantId: string): Promise<LegalHold[]> {
    if (this.dataSource) {
      return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
        tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).find({
          where: { tenantId },
          order: { startedAt: 'DESC' },
        }),
      );
    }

    return this.holdRepo.find({ where: { tenantId }, order: { startedAt: 'DESC' } });
  }

  /**
   * Get only active legal holds for a tenant.
   */
  async getActiveHolds(tenantId: string): Promise<LegalHold[]> {
    if (this.dataSource) {
      return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
        tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).find({
          where: { tenantId, isActive: true },
          order: { startedAt: 'DESC' },
        }),
      );
    }

    return this.holdRepo.find({
      where: { tenantId, isActive: true },
      order: { startedAt: 'DESC' },
    });
  }

  /**
   * Invalidate the Redis projection after the authoritative transaction commits.
   * Prevents stale cached legal hold status from allowing deletion of
   * messages that are now under legal hold (or vice versa).
   *
   * Cache key pattern: msg:legal_hold:{tenantId}:{channelId|'all'}
   * @see MSG-MEDIUM-023
   */
  async invalidateLegalHoldProjection(tenantId: string, channelId: string | null): Promise<void> {
    if (!this.redis) return;

    try {
      const channelKey = channelId ?? 'all';
      const cacheKey = `msg:legal_hold:${tenantId}:${channelKey}`;
      await this.redis.del(cacheKey);

      // Also invalidate the tenant-wide key since it affects all channels
      if (channelId) {
        await this.redis.del(`msg:legal_hold:${tenantId}:all`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // LEGAL-MEDIUM-001: trip the process-local breaker so cache READERS
      // skip the cache and query the DB until Redis recovers. Letting the
      // entry expire naturally via TTL would leave a destructive-op window
      // where stale "no-hold" cache convinced callers to delete data that
      // had just been placed under hold.
      this.cacheBreakerOpenedAt = Date.now();
      this.logger.warn(
        `Legal hold cache invalidation failed (breaker OPEN, cache reads will bypass): ${message}`,
      );
    }
  }
}
