import {
  BadRequestException,
  Injectable,
  Logger,
  ForbiddenException,
  Inject,
  Optional,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  Repository,
  IsNull,
  EntityManager,
  FindOptionsWhere,
} from 'typeorm';
import Redis from 'ioredis';

import {
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { LEGAL_HOLD_MIN_RELEASE_REASON_CHARS } from '@platform/event-contracts';
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
  constructor(message: string, public readonly tenantId: string, public readonly channelId: string | null) {
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

// Minimum release-reason length is the shared SSoT
// `LEGAL_HOLD_MIN_RELEASE_REASON_CHARS` from `@platform/event-contracts` — the
// same constant admin-api's `ReleaseLegalHoldDto` uses at the REST boundary, so
// a sub-threshold reason is rejected identically at the edge and here (defense
// in depth, with the DB CHECK constraint as the schema-layer backstop). Per the
// legal-hold-auditor agent spec § "Override protocol": "explicit reason (≥ 50
// chars)" (LEGAL-MEDIUM-002 cure).

/**
 * Manages legal holds on messaging data.
 *
 * When a legal hold is active, messages in scope (tenant-wide or channel-specific)
 * cannot be deleted by GDPR anonymise or retention cleanup.
 *
 * Only TENANT_ADMIN or SUPER_ADMIN may toggle legal holds.
 *
 * @see ADR-012 Phase 3 (Legal Hold Support)
 */
@Injectable()
export class LegalHoldService {
  private readonly logger = new Logger(LegalHoldService.name);

  /**
   * Process-local circuit breaker for cache invalidation (LEGAL-MEDIUM-001 cure).
   *
   * Tripped when invalidateLegalHoldCache() catches a Redis error.
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
    @Optional() @Inject(REDIS_CLIENT)
    private readonly redis?: Redis,
    @Optional() @InjectDataSource()
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
   * Activate a legal hold on a tenant or specific channel.
   *
   * @param tenantId - Tenant identifier
   * @param channelId - Optional channel to scope the hold (null = tenant-wide)
   * @param reason - Human-readable reason for the hold
   * @param userId - User activating the hold
   * @param legalMatterId - UUID of the legal matter/regulatory request (REQUIRED for GDPR proportionality)
   * @param options - Optional fields: legalMatterDescription, requestedBy, expiresAt
   * @param manager Optional EntityManager for transactional callers.
   *   BEFORE: no manager parameter -- activate() used its own injected repo,
   *   so it was always outside the caller's transaction boundary.
   *   WHY: ToggleLegalHoldHandler wraps activate() + audit + outbox in one
   *   dataSource.transaction(). Without manager propagation, activate() committed
   *   independently -- if audit or outbox save failed, the hold was already committed
   *   but had no audit trail (ghost legal hold).
   *   With manager: all three writes share the same transaction context.
   */
  async activate(
    tenantId: string,
    channelId: string | null,
    reason: string,
    userId: string,
    legalMatterId: string,
    options?: {
      legalMatterDescription?: string;
      requestedBy?: string;
      expiresAt?: Date;
    },
    manager?: EntityManager,
  ): Promise<LegalHold> {
    // SECURITY: legalMatterId is mandatory for GDPR proportionality.
    // A hold without a legal matter reference is a blanket freeze that violates
    // data protection regulations.
    // @see MSG-CRITICAL-018
    if (!legalMatterId) {
      throw new ForbiddenException(
        'legalMatterId is required: a legal hold must reference a specific legal matter (GDPR proportionality)',
      );
    }

    // Use caller's transaction manager if provided, fall back to injected
    // request-scoped repo. The `manager` branch wraps via tenantManagerRepo
    // so cross-tenant rows can never be written from inside a caller's
    // transaction; the fallback `this.holdRepo` branch carries explicit
    // `tenantId` in every downstream `where:` clause.
    const repo = manager
      ? tenantManagerRepo(manager, LegalHold, tenantId)
      : this.holdRepo;

    // Check for existing active hold on same scope
    const existing = await repo.findOne({
      where: {
        tenantId,
        channelId: channelId ?? IsNull(),
        isActive: true,
      },
    });

    if (existing) {
      throw new ForbiddenException(
        `An active legal hold already exists for this scope (hold ID: ${existing.id})`,
      );
    }

    const hold = repo.create({
      tenantId,
      channelId,
      reason,
      legalMatterId,
      legalMatterDescription: options?.legalMatterDescription ?? null,
      requestedBy: options?.requestedBy ?? null,
      expiresAt: options?.expiresAt ?? null,
      startedBy: userId,
      isActive: true,
    });
    const saved = await repo.save(hold);

    // IMPORTANT: Invalidate any cached legal hold status on toggle to prevent
    // stale cache from allowing deletion of held messages during the staleness window.
    // @see MSG-MEDIUM-023
    await this.invalidateLegalHoldCache(tenantId, channelId);

    this.logger.log(
      `Legal hold activated: id=${saved.id}, tenant=${tenantId}, ` +
      `channel=${channelId ?? 'all'}, legalMatter=${legalMatterId}, by=${userId}`,
    );
    return saved;
  }

  /**
   * Release (deactivate) an existing legal hold.
   *
   * # Dual-approver protocol (LEGAL-MEDIUM-002 cure)
   *
   * Pre-cure release was a single-identity operation: any SUPER_ADMIN
   * with the hold's id could end the hold. The agent spec mandates
   * "Override protocol: requires ALL of: SUPER_ADMIN role + MFA step-up
   * (≤5min) + explicit reason (≥50 chars) + dual-approver (second
   * SUPER_ADMIN click-through)".
   *
   * Post-cure release requires:
   *   - userId  → the SUPER_ADMIN actually committing the release
   *   - approverId → a SECOND SUPER_ADMIN that countersigned
   *   - releaseReason ≥ 50 chars
   *   - userId !== approverId (no self-approval)
   *
   * The DB has CHECK constraint `chk_legal_hold_no_self_approval`
   * pinning the same invariant at schema level so a code regression
   * cannot leak around it. The MFA step-up is wired via auth-service
   * claims (the auth-security-expert follow-on).
   *
   * @param holdId Hold to release.
   * @param tenantId Tenant scope (lookup is keyed on it — prevents cross-tenant release).
   * @param userId The releaser (must equal an authenticated SUPER_ADMIN).
   * @param approverId The countersigning second SUPER_ADMIN. MUST differ from userId.
   * @param releaseReason ≥ 50 chars justification recorded on the row.
   * @param manager Optional EntityManager for transactional callers (same rationale as activate).
   */
  async release(
    holdId: string,
    tenantId: string,
    userId: string,
    approverId: string,
    releaseReason: string,
    manager?: EntityManager,
  ): Promise<LegalHold> {
    if (approverId === userId) {
      throw new BadRequestException('Legal hold release requires a distinct second approver');
    }
    if (releaseReason.trim().length < LEGAL_HOLD_MIN_RELEASE_REASON_CHARS) {
      throw new BadRequestException(
        `Legal hold release reason must be at least ${LEGAL_HOLD_MIN_RELEASE_REASON_CHARS} characters`,
      );
    }

    // tenantId is required so the find below cannot match a hold that
    // belongs to a different tenant than the caller. Without this scope,
    // a user from Tenant A who learned a hold's id (via leaked log,
    // forwarded ticket, etc.) could release Tenant B's hold — defeating
    // GDPR's per-tenant retention guarantees. The tenantManagerRepo
    // wrapper enforces the same scope structurally on the manager-branch.
    const repo = manager
      ? tenantManagerRepo(manager, LegalHold, tenantId)
      : this.holdRepo;

    const hold = await repo.findOne({ where: { id: holdId, tenantId } });
    if (!hold) {
      throw new ForbiddenException(`Legal hold not found: ${holdId}`);
    }
    if (!hold.isActive) {
      throw new ForbiddenException(`Legal hold ${holdId} is already released`);
    }

    hold.isActive = false;
    hold.releasedBy = userId;
    hold.releasedByApprover = approverId;
    hold.releaseReason = releaseReason;
    hold.releasedAt = new Date();
    const saved = await repo.save(hold);

    // IMPORTANT: Invalidate cached legal hold status on release.
    // @see MSG-MEDIUM-023
    await this.invalidateLegalHoldCache(hold.tenantId, hold.channelId ?? null);

    this.logger.log(`Legal hold released: id=${holdId}, by=${userId}`);
    return saved;
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
      tenantHold = await deadline(
        findHold({ tenantId, channelId: IsNull(), isActive: true }),
      );
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
    if (tenantHold && !this.isExpired(tenantHold)) return true;

    // If a specific channel is requested, also check channel-level hold
    if (channelId) {
      let channelHold: LegalHold | null;
      try {
        channelHold = await deadline(
          findHold({ tenantId, channelId, isActive: true }),
        );
      } catch (err: unknown) {
        if (err instanceof LegalHoldCheckUnavailable) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new LegalHoldCheckUnavailable(
          `Hold registry query failed: ${message}`,
          tenantId,
          channelId,
        );
      }
      if (channelHold && !this.isExpired(channelHold)) return true;
    }

    return false;
  }

  /**
   * Check if a legal hold has expired based on its expiresAt field.
   * Expired holds are still active (isActive=true) but should not enforce
   * data retention. They must be explicitly reviewed and released or renewed.
   *
   * @param hold - The legal hold to check
   * @returns true if the hold has an expiresAt date in the past
   */
  private isExpired(hold: LegalHold): boolean {
    if (!hold.expiresAt) return false;
    return hold.expiresAt < new Date();
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

    return holds
      .filter((h) => h.channelId !== null)
      .map((h) => h.channelId as string);
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
   * Invalidate Redis cache for legal hold status when a hold is toggled.
   * Prevents stale cached legal hold status from allowing deletion of
   * messages that are now under legal hold (or vice versa).
   *
   * Cache key pattern: msg:legal_hold:{tenantId}:{channelId|'all'}
   * @see MSG-MEDIUM-023
   */
  private async invalidateLegalHoldCache(
    tenantId: string,
    channelId: string | null,
  ): Promise<void> {
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
