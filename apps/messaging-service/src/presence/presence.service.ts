import { Injectable, Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../shared/redis.provider';

/** TTL for online presence keys in seconds (5 minutes). */
const PRESENCE_TTL = 300;

/**
 * Redis-backed user presence tracking service.
 *
 * Stores online/offline state with auto-expiring keys so that
 * stale sessions are automatically cleaned up. Last-seen timestamps
 * persist separately with no TTL until the next update.
 *
 * Graceful degradation: if Redis is unreachable, all queries return
 * "offline" rather than throwing — the UI simply shows everyone as
 * away until Redis recovers.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  // ── Key helpers ──────────────────────────────────────────────

  private presenceKey(tenantId: string, userId: string): string {
    return `msg:${tenantId}:presence:${userId}`;
  }

  private lastSeenKey(tenantId: string, userId: string): string {
    return `msg:${tenantId}:lastseen:${userId}`;
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Mark a user as online with a 5-minute TTL.
   * Also stores the current timestamp as a last-seen value.
   *
   * SECURITY: Uses Redis MULTI/EXEC for atomic updates to prevent
   * race conditions with concurrent presence changes.
   * @see MSG-HIGH-044 (presence tracking race condition)
   */
  async setOnline(tenantId: string, userId: string): Promise<void> {
    try {
      const multi = this.redis.multi();
      multi.set(this.presenceKey(tenantId, userId), 'online', 'EX', PRESENCE_TTL);
      multi.set(this.lastSeenKey(tenantId, userId), new Date().toISOString());
      await multi.exec();
    } catch (err) {
      this.logger.warn(`setOnline failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Mark a user as offline immediately and update last-seen.
   *
   * SECURITY: Uses Redis MULTI/EXEC for atomic updates.
   * @see MSG-HIGH-044 (presence tracking race condition)
   */
  async setOffline(tenantId: string, userId: string): Promise<void> {
    try {
      const multi = this.redis.multi();
      multi.del(this.presenceKey(tenantId, userId));
      multi.set(this.lastSeenKey(tenantId, userId), new Date().toISOString());
      await multi.exec();
    } catch (err) {
      this.logger.warn(`setOffline failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Refresh the TTL of an existing presence key (heartbeat).
   */
  async refreshPresence(tenantId: string, userId: string): Promise<void> {
    try {
      await this.redis.expire(this.presenceKey(tenantId, userId), PRESENCE_TTL);
    } catch (err) {
      this.logger.warn(`refreshPresence failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Check whether a single user is currently online.
   * Returns `false` if Redis is unavailable (fail-safe).
   */
  async isOnline(tenantId: string, userId: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(this.presenceKey(tenantId, userId));
      return exists === 1;
    } catch (err) {
      this.logger.warn(`isOnline failed for ${userId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Batch-check online status for multiple users.
   * Returns a Map of userId to boolean. On Redis failure, all users
   * are reported as offline.
   */
  async getOnlineUsers(
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (userIds.length === 0) return result;

    try {
      const keys = userIds.map((uid) => this.presenceKey(tenantId, uid));
      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.exists(key);
      }
      const responses = await pipeline.exec();

      for (let i = 0; i < userIds.length; i++) {
        const userId = userIds[i] as string;
        const response = responses?.[i];
        // ioredis pipeline response: [error | null, value]
        const isPresent = response && !response[0] && response[1] === 1;
        result.set(userId, !!isPresent);
      }
    } catch (err) {
      this.logger.warn(`getOnlineUsers failed: ${(err as Error).message}`);
      for (const uid of userIds) {
        result.set(uid, false);
      }
    }

    return result;
  }

  /**
   * Retrieve the last-seen timestamp for a user.
   * Returns `null` if never set or on Redis failure.
   */
  async getLastSeen(tenantId: string, userId: string): Promise<Date | null> {
    try {
      const iso = await this.redis.get(this.lastSeenKey(tenantId, userId));
      if (!iso) return null;
      const date = new Date(iso);
      return isNaN(date.getTime()) ? null : date;
    } catch (err) {
      this.logger.warn(`getLastSeen failed for ${userId}: ${(err as Error).message}`);
      return null;
    }
  }
}
