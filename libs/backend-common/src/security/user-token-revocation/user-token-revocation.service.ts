import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { RedisService } from '../../redis/redis.service';

/**
 * User-level token revocation — the canonical SSoT for "invalidate every access
 * token a user currently holds".
 *
 * # Why this exists (RBAC-HIGH-001 / SEC-MEDIUM-006 consolidation)
 *
 * The gateway (`apps/gateway-api`) already enforces user-level invalidation on
 * EVERY authenticated request: its JWT guard reads the Redis key
 * `user_blacklist:{userId}` (a flat Unix-seconds epoch) and rejects any token
 * whose `iat` is older than that epoch. That read was the ONLY consumer of the
 * key; nothing wrote it on an authorization change, so a permission REVOKE did
 * not take effect until the access token expired.
 *
 * This module makes the key contract a shared primitive: the WRITE side
 * (auth-service, on a permission-reducing RBAC change / password change / token
 * reuse) and the READ side (the gateway enforcement) now agree on ONE key
 * builder and ONE epoch format, so a revoke propagates fleet-wide immediately —
 * the user's live tokens are rejected on their next request, forcing a refresh
 * that re-mints with current permissions. Redis-backed for cross-instance
 * correctness; in-memory fallback for single-instance dev/test.
 */

/**
 * The canonical Redis key holding a user's token-invalidation epoch. This is the
 * ONE definition of the contract the gateway read path and every writer share —
 * never hand-write `user_blacklist:${userId}` anywhere else.
 */
export function userBlacklistKey(userId: string): string {
  return `user_blacklist:${userId}`;
}

/** DI token for the canonical user-token-revocation primitive. */
export const USER_TOKEN_REVOCATION = Symbol('USER_TOKEN_REVOCATION');

/**
 * The minimal Redis surface this primitive needs. RedisService satisfies it
 * structurally, so DI injects the concrete service while the dependency stays
 * narrow (and a test can supply a two-method double with no cast).
 */
export interface RedisKeyValue {
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  get(key: string): Promise<string | null>;
}

export interface IUserTokenRevocation {
  /**
   * Invalidate every token issued to `userId` before `at` (default: now).
   * Writes the invalidation epoch to the shared `user_blacklist:{userId}` key.
   */
  revokeUserTokens(userId: string, at?: Date): Promise<void>;

  /**
   * True if a token issued at `issuedAt` is still valid for `userId` (i.e. it
   * was issued at/after the recorded invalidation epoch, or none is recorded).
   */
  isTokenValid(userId: string, issuedAt: Date): Promise<boolean>;
}

@Injectable()
export class UserTokenRevocationService implements IUserTokenRevocation {
  private readonly logger = new Logger(UserTokenRevocationService.name);

  // In-memory fallback (single-instance dev/test only) — userId → epoch seconds.
  private readonly fallback = new Map<string, number>();

  // The gateway pins user-blacklist entries with a 24h TTL (the JWT max
  // lifetime); after that any token issued before the epoch has itself expired,
  // so the marker is safe to drop. Match that contract exactly.
  private static readonly TTL_SECONDS = 24 * 60 * 60;

  constructor(
    // Injected as the concrete RedisService (which satisfies RedisKeyValue);
    // typed narrow so the dependency is the two operations actually used.
    @Optional() @Inject(RedisService) private readonly redis?: RedisKeyValue,
  ) {}

  async revokeUserTokens(userId: string, at: Date = new Date()): Promise<void> {
    const epochSeconds = Math.floor(at.getTime() / 1000);
    if (this.redis) {
      await this.redis.set(userBlacklistKey(userId), String(epochSeconds), UserTokenRevocationService.TTL_SECONDS);
    } else {
      this.fallback.set(userId, epochSeconds);
    }
    this.logger.log(`Revoked user tokens: userId=${userId}, invalidatedAt=${epochSeconds}`);
  }

  async isTokenValid(userId: string, issuedAt: Date): Promise<boolean> {
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
    let invalidatedAt: number | null = null;

    if (this.redis) {
      const raw = await this.redis.get(userBlacklistKey(userId));
      invalidatedAt = raw === null ? null : Number.parseInt(raw, 10);
    } else {
      invalidatedAt = this.fallback.get(userId) ?? null;
    }

    if (invalidatedAt === null || Number.isNaN(invalidatedAt)) {
      return true;
    }
    // A token is valid iff it was issued at or after the invalidation epoch —
    // identical to the gateway's `issuedAt < invalidatedAt → invalid` check.
    return issuedAtSeconds >= invalidatedAt;
  }
}
