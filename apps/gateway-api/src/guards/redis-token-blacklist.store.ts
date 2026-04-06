import { Injectable, Logger, Inject } from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common';

/**
 * Token blacklist store interface
 */
export interface TokenBlacklistStore {
  /**
   * Add a token to the blacklist
   * @param jti JWT ID
   * @param exp Expiration timestamp (Unix seconds)
   */
  add(jti: string, exp: number): Promise<void>;

  /**
   * Check if a token is blacklisted
   * @param jti JWT ID
   * @returns true if blacklisted
   */
  isBlacklisted(jti: string): Promise<boolean>;

  /**
   * Composite token validity check: per-token blacklist + user-level invalidation.
   * Returns false (token is invalid) when:
   *   - the token JTI is explicitly blacklisted, OR
   *   - the user's entire token family was invalidated after this token was issued.
   * Fails closed — returns false on any store error.
   * @param jti   JWT ID
   * @param userId  Subject (user ID) from the JWT payload
   * @param issuedAt  iat claim value (Unix seconds)
   */
  isValidToken(jti: string, userId: string, issuedAt: number): Promise<boolean>;

  /**
   * Invalidate all tokens issued to a user before the given timestamp.
   * Stores invalidatedAt in user_blacklist:{userId} with a 24-hour TTL.
   * @param userId       Subject (user ID)
   * @param invalidatedAt Unix seconds — tokens with iat < this value are invalid
   */
  blacklistUserTokens(userId: string, invalidatedAt: number): Promise<void>;

  /**
   * Remove expired entries (for in-memory fallback)
   */
  cleanup?(): void;
}

/**
 * Redis-based token blacklist store for distributed deployments
 *
 * SECURITY: Uses Redis for distributed token revocation across multiple
 * gateway instances. Tokens are automatically removed when they expire
 * via Redis TTL.
 *
 * Enable via TOKEN_BLACKLIST_USE_REDIS=true environment variable.
 */
@Injectable()
export class RedisTokenBlacklistStore implements TokenBlacklistStore {
  private readonly logger = new Logger(RedisTokenBlacklistStore.name);
  private readonly keyPrefix = 'token:blacklist:';

  constructor(@Inject(RedisService) private readonly redisService: RedisService) {}

  async add(jti: string, exp: number): Promise<void> {
    // Calculate TTL (time until token expires)
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = Math.max(exp - now, 1);

    // Store blacklisted token with TTL
    // Value is just "1" since we only need to check existence
    // SECURITY: Surface errors to callers so token revocation failures are not silent.
    // A silent failure here means a revoked token remains valid -- unacceptable.
    await this.redisService.set(
      this.keyPrefix + jti,
      '1',
      ttlSeconds,
    );

    this.logger.debug(`Token blacklisted: ${jti.substring(0, 8)}... (TTL: ${ttlSeconds}s)`);
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    try {
      const exists = await this.redisService.get(this.keyPrefix + jti);
      return exists !== null;
    } catch (error) {
      this.logger.error(`Failed to check token blacklist: ${error}`);
      // SECURITY: Fail closed - if we can't verify, treat token as potentially revoked
      // This prevents revoked tokens from being used during Redis outages
      // Trade-off: Availability impact during Redis failures, but prevents security bypass
      // For security-critical applications, this is the correct approach
      return true;
    }
  }

  async isValidToken(jti: string, userId: string, issuedAt: number): Promise<boolean> {
    try {
      // (1) Per-token blacklist check
      const jtiBlacklisted = await this.redisService.get(this.keyPrefix + jti);
      if (jtiBlacklisted !== null) {
        return false;
      }

      // (2) User-level invalidation check
      const userInvalidatedAt = await this.redisService.get(`user_blacklist:${userId}`);
      if (userInvalidatedAt !== null) {
        const invalidatedAt = parseInt(userInvalidatedAt, 10);
        if (!isNaN(invalidatedAt) && issuedAt < invalidatedAt) {
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to validate token (fail-closed): ${error}`);
      // SECURITY: Fail closed — Redis error means we cannot confirm validity
      return false;
    }
  }

  async blacklistUserTokens(userId: string, invalidatedAt: number): Promise<void> {
    // JWT max lifetime: 24 hours
    const ttlSeconds = 24 * 60 * 60;
    await this.redisService.set(
      `user_blacklist:${userId}`,
      String(invalidatedAt),
      ttlSeconds,
    );
    this.logger.log(`User tokens blacklisted: userId=${userId}, invalidatedAt=${invalidatedAt}`);
  }
}

/**
 * In-memory token blacklist store for single-instance deployments
 *
 * WARNING: This store does NOT work across multiple gateway instances.
 * Use RedisTokenBlacklistStore for distributed deployments.
 */
@Injectable()
export class InMemoryTokenBlacklistStore implements TokenBlacklistStore {
  private readonly logger = new Logger(InMemoryTokenBlacklistStore.name);
  private readonly blacklist = new Map<string, number>();
  private readonly userBlacklist = new Map<string, number>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval
    this.startCleanup();
  }

  async add(jti: string, exp: number): Promise<void> {
    this.blacklist.set(jti, exp);
    this.logger.debug(`Token blacklisted (in-memory): ${jti.substring(0, 8)}...`);
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    const exp = this.blacklist.get(jti);
    if (exp === undefined) {
      return false;
    }
    // Lazy expiry: remove expired entries on access
    const now = Math.floor(Date.now() / 1000);
    if (exp < now) {
      this.blacklist.delete(jti);
      return false;
    }
    return true;
  }

  async isValidToken(jti: string, userId: string, issuedAt: number): Promise<boolean> {
    if (await this.isBlacklisted(jti)) {
      return false;
    }
    const invalidatedAt = this.userBlacklist.get(userId);
    if (invalidatedAt !== undefined && issuedAt < invalidatedAt) {
      return false;
    }
    return true;
  }

  async blacklistUserTokens(userId: string, invalidatedAt: number): Promise<void> {
    this.userBlacklist.set(userId, invalidatedAt);
    this.logger.log(`User tokens blacklisted (in-memory): userId=${userId}, invalidatedAt=${invalidatedAt}`);
  }

  cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    let cleaned = 0;

    for (const [jti, exp] of this.blacklist.entries()) {
      if (exp < now) {
        this.blacklist.delete(jti);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired blacklist entries`);
    }
  }

  private startCleanup(): void {
    // Cleanup every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Injection token for token blacklist store
 */
export const TOKEN_BLACKLIST_STORE = Symbol('TOKEN_BLACKLIST_STORE');
