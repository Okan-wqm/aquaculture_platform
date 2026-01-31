import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@platform/backend-common';

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

  constructor(private readonly redisService: RedisService) {}

  async add(jti: string, exp: number): Promise<void> {
    try {
      // Calculate TTL (time until token expires)
      const now = Math.floor(Date.now() / 1000);
      const ttlSeconds = Math.max(exp - now, 1);

      // Store blacklisted token with TTL
      // Value is just "1" since we only need to check existence
      await this.redisService.set(
        this.keyPrefix + jti,
        '1',
        ttlSeconds,
      );

      this.logger.debug(`Token blacklisted: ${jti.substring(0, 8)}... (TTL: ${ttlSeconds}s)`);
    } catch (error) {
      this.logger.error(`Failed to blacklist token: ${error}`);
      // Don't throw - fail open to avoid blocking legitimate requests
      // The token will still expire naturally
    }
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
    return this.blacklist.has(jti);
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
