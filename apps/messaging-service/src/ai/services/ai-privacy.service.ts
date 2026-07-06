/**
 * @module AiPrivacyService
 * @description Dual-consent privacy gate for all AI analysis operations.
 * AI processing requires BOTH tenant-level enablement AND per-user opt-in.
 * Settings are cached in Redis with a DB fallback for cold starts.
 *
 * # Architecture (ADR-011 + Tier-1 Make-Impossible)
 *
 * User-level consent reads/writes go through the TypeORM repository on the
 * canonical `UserAiConsent` entity (no entity-level schema; search_path routes
 * to the tenant schema). Tenant-level AI enablement is NOT stored here — it is
 * owned by ai-service and queried over `request.ai.isEnabled` (SSoT).
 *
 * Repositories derive table names + column names + schema qualification
 * from entity metadata at compile time — drift between the SQL the
 * service emits and the actual DB shape is structurally impossible.
 *
 * # History (why this refactor exists)
 *
 * Prior revision used hand-written raw SQL with FOUR layers of drift:
 *   - wrong table names (`tenant_settings` ≠ `tenant_ai_settings`)
 *   - wrong column names (`aiAnalysisEnabled` ≠ `aiEnabled`)
 *   - wrong table names (`user_preferences` ≠ `user_ai_consents`)
 *   - wrong column names (`aiAnalysisConsent` ≠ `consented`)
 *   - missing tenant-aware schema routing checks
 *
 * Plus a `DELETE FROM embeddings_metadata WHERE userId = ...` that
 * targeted columns that don't exist (the table is a model registry,
 * not user data) — wrapped in `.catch(() => {})` to swallow the
 * permanent failure. Unit tests asserted on the broken SQL strings,
 * so coverage was green while runtime was permanently broken (audit
 * theater anti-pattern). Refactor removes the dead block, replaces
 * the working raw query (vector-typed `messages.embedding` clearing)
 * with explicit tenant-routed SQL inside a `BypassRlsService` scope.
 *
 * @see ADR-012 section 12.5 (AI Privacy Framework)
 * @see docs/reviews/messaging-expert/2026-04-14-ai-privacy-naming-drift.md
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';
import {
  BypassRlsService,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import { UserAiConsent } from '../entities/user-ai-consent.entity';

/**
 * Redis TTL for cached consent/settings (60 seconds).
 * SECURITY: Reduced from 600s (10 minutes) to 60s. When a user revokes AI
 * consent, AI features must stop within a reasonable window. 10 minutes was
 * too long — a user who revokes consent would still have their messages
 * analyzed for up to 10 minutes. 60s is the maximum acceptable staleness
 * for consent decisions. Additionally, consent changes explicitly
 * invalidate the cache (see setUserAiConsent and setTenantAiEnabled).
 * @see MSG-MEDIUM-037
 */
const CACHE_TTL_SECONDS = 60;

/** Timeout for the request.ai.isEnabled NATS round-trip (fail closed on breach). */
const AI_ENABLED_TIMEOUT_MS = 3000;

/** Redis key prefix for tenant AI settings. */
const TENANT_KEY_PREFIX = 'ai:tenant:';

/** Redis key prefix for user AI consent. */
const USER_KEY_PREFIX = 'ai:user:consent:';

@Injectable()
export class AiPrivacyService {
  private readonly logger = new Logger(AiPrivacyService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly bypassRls: BypassRlsService,
    // SSoT: tenant AI enablement is answered by ai-service over request.ai.isEnabled.
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  /**
   * Check if a message from a specific user in a tenant can be analyzed by
   * AI. Returns true ONLY when both tenant-level AND user-level consent are
   * granted — dual-gate by design.
   */
  async canAnalyzeMessage(tenantId: string, userId: string): Promise<boolean> {
    try {
      const [tenantEnabled, userConsented] = await Promise.all([
        this.isTenantAiEnabled(tenantId),
        this.hasUserConsented(tenantId, userId),
      ]);
      return tenantEnabled && userConsented;
    } catch (err: unknown) {
      // Fail closed: any unexpected fault → assume "not allowed" rather
      // than crashing the message pipeline. The error itself is logged
      // (not swallowed) so the cause is visible in operations.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Privacy gate check failed for tenant=${tenantId} user=${userId}; ` +
          `defaulting to denied: ${message}`,
      );
      return false;
    }
  }

  /**
   * Tenant-level AI feature flag (cache → repository fallback).
   *
   * Returns the canonical entity field `aiEnabled` (NOT the legacy
   * fictional `aiAnalysisEnabled` that the previous raw-SQL revision
   * pretended to read). Operators reading this code can grep
   * `tenant_ai_settings.aiEnabled` and find both the SQL column AND
   * the application invariant in one place.
   */
  async isTenantAiEnabled(tenantId: string): Promise<boolean> {
    const cacheKey = `${TENANT_KEY_PREFIX}${tenantId}`;
    const cached = await this.safeRedisGet(cacheKey);
    if (cached !== null) {
      return cached === 'true';
    }

    // SSoT: ai-service owns tenant AI enablement (config.isEnabled AND a valid
    // provider key). Ask it over NATS instead of a duplicate local flag that
    // could disagree (enabled here but no key there → wasted AI_KEY_MISSING
    // round-trips). The 60s Redis cache keeps this off the hot path.
    let enabled = false;
    try {
      const response = await firstValueFrom(
        this.natsClient
          .send<{ enabled: boolean }>('request.ai.isEnabled', { tenantId })
          .pipe(timeout(AI_ENABLED_TIMEOUT_MS)),
      );
      enabled = response?.enabled === true;
    } catch (err: unknown) {
      // Fail closed — an unreachable ai-service must not present AI as available.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `request.ai.isEnabled failed for tenant=${tenantId}; defaulting to disabled: ${message}`,
      );
      enabled = false;
    }
    await this.safeRedisSetEx(cacheKey, CACHE_TTL_SECONDS, String(enabled));
    return enabled;
  }

  /**
   * User-level AI consent (cache → repository fallback).
   *
   * Returns the canonical entity field `consented` (NOT the legacy
   * fictional `aiAnalysisConsent`).
   */
  async hasUserConsented(tenantId: string, userId: string): Promise<boolean> {
    const cacheKey = `${USER_KEY_PREFIX}${tenantId}:${userId}`;
    const cached = await this.safeRedisGet(cacheKey);
    if (cached !== null) {
      return cached === 'true';
    }

    const consent = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      (queryRunner) =>
        queryRunner.manager.findOne(UserAiConsent, {
          where: { tenantId, userId },
        }),
    );
    const consented = consent?.consented ?? false;
    await this.safeRedisSetEx(cacheKey, CACHE_TTL_SECONDS, String(consented));
    return consented;
  }

  // setTenantAiEnabled removed — tenant AI enablement is owned by ai-service
  // (updateAiProviderSettings.isEnabled). Messaging reads it via request.ai.isEnabled.

  /**
   * Update user-level AI consent. Each user controls their own opt-in.
   * Invalidates the Redis cache. When consent is REVOKED, surgically
   * clears any embeddings the platform retained for the user's messages
   * (GDPR Article 17 / right-to-be-forgotten compliance — once consent
   * is withdrawn, prior derived artifacts must also disappear).
   */
  async setUserAiConsent(
    tenantId: string,
    userId: string,
    consented: boolean,
  ): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      (queryRunner) =>
        queryRunner.manager.upsert(
          UserAiConsent,
          { tenantId, userId, consented },
          { conflictPaths: ['tenantId', 'userId'] },
        ),
    );
    await this.safeRedisDel(`${USER_KEY_PREFIX}${tenantId}:${userId}`);

    if (!consented) {
      await this.sweepUserEmbeddings(tenantId, userId);
    }

    this.logger.log(
      `User ${userId} in tenant ${tenantId} AI consent set to: ${consented}`,
    );
  }

  /**
   * NULL out embeddings for all messages authored by a specific user
   * within a tenant. Called when a user revokes AI data consent so that
   * previously generated embeddings disappear from the vector store
   * along with the consent flag.
   *
   * # Why raw SQL
   *
   * `messages.embedding` is `vector(384)` (pgvector). TypeORM has no
   * first-class vector type and will not generate an UPDATE that NULLs
   * a vector column correctly via the repository API. Raw SQL is the
   * minimal correct primitive. The query intentionally uses unqualified
   * table names so TenantConnectionBootstrap's tenant-scoped search_path
   * routes the sweep to the same physical tenant schema as repository
   * reads and writes.
   *
   * # Why BypassRlsService
   *
   * The sweep runs in the user's request context (consent revocation
   * mutation), so RLS is active for the user's tenant. The UPDATE
   * already filters by `c.tenantId = $1` — RLS would either pass it
   * (matches the user's tenant) or deny (cross-tenant attempt). For
   * audit clarity we wrap in `withBypass` so the operation is logged
   * with an explicit label even when the RLS predicate would also
   * permit the write — a future refactor that moves this into a
   * background job (cron) would NOT have user-tenant context, and the
   * bypass label is the same.
   *
   * # Removed: dead embeddings_metadata DELETE
   *
   * Prior revision: `DELETE FROM embeddings_metadata WHERE tenantId =
   * $1 AND userId = $2`. The `embeddings_metadata` entity has neither
   * `tenantId` nor `userId` columns (it's a platform-wide model
   * registry — see embeddings-metadata.entity.ts). The query was
   * ALWAYS broken and was wrapped in `.catch(() => {})` to swallow
   * the permanent failure. Removed entirely; the actual sweep target
   * is the `messages.embedding` vector column above.
   */
  private async sweepUserEmbeddings(tenantId: string, userId: string): Promise<void> {
    try {
      await this.bypassRls.withBypass(
        `ai-privacy:embedding-sweep:tenant=${tenantId}:user=${userId}`,
        async () => {
          const result = await runInTenantTransaction(
            this.dataSource,
            'messaging',
            tenantId,
            (queryRunner) =>
              queryRunner.query(
                `UPDATE "messages" m
                 SET "embedding" = NULL
                 FROM "channels" c
                 WHERE m."channelId" = c."id"
                   AND c."tenantId" = $1
                   AND m."senderId" = $2
                   AND m."embedding" IS NOT NULL`,
                [tenantId, userId],
              ),
          );

          // pg driver returns [rows, rowCount] for UPDATE.
          const rowCount = Array.isArray(result) ? (result[1] as number | undefined) : undefined;
          if (rowCount && rowCount > 0) {
            this.logger.log(
              `SECURITY: cleared ${rowCount} embeddings for user ${userId} in tenant ${tenantId} (consent revoked)`,
            );
          }
        },
      );
    } catch (err: unknown) {
      // Sweep is GDPR Art-17 critical. Failure is logged loud (NOT
      // swallowed silently) so on-call sees it. We do NOT re-throw: the
      // user's consent change must succeed and persist; sweep is a
      // best-effort follow-up. A retry job (separately tracked) is the
      // right place to handle persistent sweep failures, not blocking
      // the consent-revocation transaction.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `EMBEDDING_SWEEP_FAILED: tenant=${tenantId} user=${userId}: ${message}. ` +
          `Consent flag was updated but residual embeddings may remain — ` +
          `escalate to retry pipeline.`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  // ── Redis convenience wrappers — graceful degradation for cache ────────

  /**
   * Safe Redis GET. Returns null on error so callers fall through to the
   * authoritative repository read instead of crashing. Cache outage MUST
   * NOT block consent decisions.
   */
  private async safeRedisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis GET failed for ${key}: ${message}`);
      return null;
    }
  }

  /**
   * Safe Redis SETEX. Cache write is best-effort; failure is logged but
   * the calling read still returns the authoritative DB value.
   */
  private async safeRedisSetEx(key: string, ttl: number, value: string): Promise<void> {
    try {
      await this.redis.setex(key, ttl, value);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis SETEX failed for ${key}: ${message}`);
    }
  }

  /**
   * Safe Redis DEL. After a write, cache invalidation MUST be attempted
   * but its failure does not roll back the write — the next read will
   * pay one repository hit, refresh the cache, and converge. Worst case
   * is one stale 60s window.
   */
  private async safeRedisDel(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis DEL failed for ${key}: ${message}`);
    }
  }
}
