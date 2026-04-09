/**
 * @module AiPrivacyService
 * @description Dual-consent privacy gate for all AI analysis operations.
 * Both tenant-level `aiAnalysisEnabled` AND user-level `aiAnalysisConsent`
 * must be true before any AI processing occurs. Settings are cached in Redis
 * with a DB fallback for cold starts.
 * @see ADR-012 section 12.5 (AI Privacy Framework)
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/** Redis TTL for cached consent/settings (10 minutes). */
const CACHE_TTL_SECONDS = 600;

/** Redis key prefix for tenant AI settings. */
const TENANT_KEY_PREFIX = 'ai:tenant:';

/** Redis key prefix for user AI consent. */
const USER_KEY_PREFIX = 'ai:user:consent:';

/**
 * Tenant-level AI analysis settings.
 */
export interface TenantAiSettings {
  aiAnalysisEnabled: boolean;
}

/**
 * User-level AI analysis consent.
 */
export interface UserAiConsent {
  aiAnalysisConsent: boolean;
}

@Injectable()
export class AiPrivacyService {
  private readonly logger = new Logger(AiPrivacyService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Check if a message from a specific user in a tenant can be analyzed by AI.
   * Returns true only when both tenant-level and user-level consent are granted.
   * @param tenantId - The tenant identifier
   * @param userId - The user identifier
   * @returns true if AI analysis is permitted
   */
  async canAnalyzeMessage(tenantId: string, userId: string): Promise<boolean> {
    try {
      const [tenantSettings, userConsent] = await Promise.all([
        this.getTenantAiSettings(tenantId),
        this.getUserAiConsent(tenantId, userId),
      ]);

      return tenantSettings.aiAnalysisEnabled && userConsent.aiAnalysisConsent;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Privacy gate check failed, defaulting to denied: ${message}`);
      return false;
    }
  }

  /**
   * Get the tenant-level AI settings. Checks Redis cache first, falls back to DB.
   * @param tenantId - The tenant identifier
   */
  async getTenantAiSettings(tenantId: string): Promise<TenantAiSettings> {
    const cacheKey = `${TENANT_KEY_PREFIX}${tenantId}`;

    // Try Redis cache
    const cached = await this.safeRedisGet(cacheKey);
    if (cached !== null) {
      return { aiAnalysisEnabled: cached === 'true' };
    }

    // Fallback to DB — check tenant_settings table in public schema
    const result = await this.dataSource.query(
      `SELECT "aiAnalysisEnabled" FROM "tenant_settings"
       WHERE "tenantId" = $1 LIMIT 1`,
      [tenantId],
    ).catch(() => []);

    const enabled = result.length > 0 ? result[0].aiAnalysisEnabled === true : false;

    // Cache the result
    await this.safeRedisSetEx(cacheKey, CACHE_TTL_SECONDS, String(enabled));

    return { aiAnalysisEnabled: enabled };
  }

  /**
   * Get user-level AI consent. Checks Redis cache first, falls back to DB.
   * @param tenantId - The tenant identifier
   * @param userId - The user identifier
   */
  async getUserAiConsent(tenantId: string, userId: string): Promise<UserAiConsent> {
    const cacheKey = `${USER_KEY_PREFIX}${tenantId}:${userId}`;

    // Try Redis cache
    const cached = await this.safeRedisGet(cacheKey);
    if (cached !== null) {
      return { aiAnalysisConsent: cached === 'true' };
    }

    // Fallback to DB — check user_preferences table
    const result = await this.dataSource.query(
      `SELECT "aiAnalysisConsent" FROM "user_preferences"
       WHERE "userId" = $1 AND "tenantId" = $2 LIMIT 1`,
      [userId, tenantId],
    ).catch(() => []);

    const consent = result.length > 0 ? result[0].aiAnalysisConsent === true : false;

    // Cache the result
    await this.safeRedisSetEx(cacheKey, CACHE_TTL_SECONDS, String(consent));

    return { aiAnalysisConsent: consent };
  }

  /**
   * Update the tenant-level AI analysis setting. Only callable by TENANT_ADMIN.
   * Invalidates the Redis cache on update.
   * @param tenantId - The tenant identifier
   * @param enabled - Whether to enable AI analysis
   */
  async updateTenantAiSetting(tenantId: string, enabled: boolean): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "tenant_settings" ("tenantId", "aiAnalysisEnabled")
       VALUES ($1, $2)
       ON CONFLICT ("tenantId")
       DO UPDATE SET "aiAnalysisEnabled" = $2`,
      [tenantId, enabled],
    );

    const cacheKey = `${TENANT_KEY_PREFIX}${tenantId}`;
    await this.safeRedisDel(cacheKey);

    this.logger.log(`Tenant ${tenantId} AI analysis set to: ${enabled}`);
  }

  /**
   * Update user-level AI analysis consent. Each user controls their own opt-in.
   * Invalidates the Redis cache on update.
   * @param tenantId - The tenant identifier
   * @param userId - The user identifier
   * @param consent - Whether the user consents to AI analysis
   */
  async updateUserAiConsent(
    tenantId: string,
    userId: string,
    consent: boolean,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "user_preferences" ("userId", "tenantId", "aiAnalysisConsent")
       VALUES ($1, $2, $3)
       ON CONFLICT ("userId", "tenantId")
       DO UPDATE SET "aiAnalysisConsent" = $3`,
      [userId, tenantId, consent],
    );

    const cacheKey = `${USER_KEY_PREFIX}${tenantId}:${userId}`;
    await this.safeRedisDel(cacheKey);

    // SECURITY: When user revokes consent, sweep all existing embeddings
    // containing their messages from the vector store.
    // @see MSG-HIGH-035 (consent opt-out does not sweep existing embeddings)
    if (!consent) {
      await this.sweepUserEmbeddings(tenantId, userId);
    }

    this.logger.log(`User ${userId} in tenant ${tenantId} AI consent set to: ${consent}`);
  }

  /**
   * Delete all embeddings for messages authored by a specific user.
   * Called when a user revokes AI data consent to ensure previously
   * generated embeddings are removed from the vector store.
   *
   * @param tenantId - The tenant identifier
   * @param userId - The user whose embeddings should be deleted
   * @see MSG-HIGH-035 (consent opt-out embedding sweep)
   */
  private async sweepUserEmbeddings(tenantId: string, userId: string): Promise<void> {
    try {
      // NULL out embeddings for all messages authored by this user.
      // Uses a join to channels to ensure tenant isolation.
      const result = await this.dataSource.query(
        `UPDATE "messages" m
         SET "embedding" = NULL
         FROM "channels" c
         WHERE m."channelId" = c."id"
           AND c."tenantId" = $1
           AND m."senderId" = $2
           AND m."embedding" IS NOT NULL`,
        [tenantId, userId],
      );

      const rowCount = result?.[1] ?? 0;
      if (rowCount > 0) {
        this.logger.log(
          `SECURITY: Swept ${rowCount} embeddings for user ${userId} in tenant ${tenantId} (consent revoked)`,
        );
      }

      // Also clean up any embedding metadata records
      await this.dataSource.query(
        `DELETE FROM "embeddings_metadata"
         WHERE "tenantId" = $1 AND "userId" = $2`,
        [tenantId, userId],
      ).catch(() => {
        // Table may not exist in all deployments
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to sweep embeddings for user ${userId}: ${message}`);
      // Do not throw — consent update should succeed even if sweep fails.
      // Sweep can be retried via a background job.
    }
  }

  /**
   * Safe Redis GET with graceful degradation. Returns null on error.
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
   * Safe Redis SETEX with graceful degradation.
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
   * Safe Redis DEL with graceful degradation.
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
