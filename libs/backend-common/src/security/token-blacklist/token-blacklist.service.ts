import { Injectable, Logger, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ITokenBlacklist } from '../interfaces';
import Redis from 'ioredis';

/**
 * Blacklisted token entry
 */
interface BlacklistEntry {
  jti: string;
  expiresAt: number;
  reason?: string;
  blacklistedAt: number;
}

/**
 * Token Blacklist Service
 *
 * Provides access token invalidation capabilities:
 * - In-memory storage for single-instance deployments
 * - Redis storage for distributed deployments
 * - Automatic cleanup of expired tokens
 *
 * Use cases:
 * - Logout from all devices
 * - Password change (invalidate all existing tokens)
 * - Security breach (invalidate compromised tokens)
 * - Account deactivation
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles token blacklisting
 * - Interface Segregation: Implements minimal ITokenBlacklist interface
 * - Dependency Inversion: Depends on ITokenBlacklist abstraction
 */
@Injectable()
export class TokenBlacklistService implements ITokenBlacklist, OnModuleDestroy {
  private readonly logger = new Logger(TokenBlacklistService.name);
  private readonly store = new Map<string, BlacklistEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private readonly useRedis: boolean;
  private readonly keyPrefix = 'token:blacklist:';

  constructor(
    private readonly configService: ConfigService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {
    this.useRedis = this.configService.get<boolean>('TOKEN_BLACKLIST_USE_REDIS', false) && !!redis;

    // Cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);

    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    if (!this.useRedis && nodeEnv === 'production') {
      this.logger.error(
        'TokenBlacklistService is using in-memory storage in production. ' +
        'Logout and token invalidation will NOT work across multiple instances. ' +
        'Set TOKEN_BLACKLIST_USE_REDIS=true and provide a Redis connection.',
      );
      throw new Error(
        'TokenBlacklistService requires Redis in production. ' +
        'Set TOKEN_BLACKLIST_USE_REDIS=true and provide a Redis connection.',
      );
    }

    if (!this.useRedis) {
      this.logger.warn(
        'TokenBlacklistService is using in-memory storage. ' +
        'This is only suitable for single-instance development/test environments.',
      );
    }

    this.logger.log(
      `Token blacklist initialized (storage: ${this.useRedis ? 'Redis' : 'in-memory'})`,
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.store.clear();
  }

  /**
   * Add token to blacklist
   */
  async add(jti: string, expiresAt: Date, reason?: string): Promise<void> {
    if (!jti) {
      this.logger.warn('Attempted to blacklist token with empty JTI');
      return;
    }

    const entry: BlacklistEntry = {
      jti,
      expiresAt: expiresAt.getTime(),
      reason,
      blacklistedAt: Date.now(),
    };

    if (this.useRedis && this.redis) {
      // Store in Redis with TTL
      const ttlMs = expiresAt.getTime() - Date.now();
      if (ttlMs > 0) {
        const key = `${this.keyPrefix}${jti}`;
        await this.redis.setex(key, Math.ceil(ttlMs / 1000), JSON.stringify(entry));
      }
    } else {
      // Store in memory
      this.store.set(jti, entry);
    }

    this.logger.debug(`Token blacklisted: ${jti.substring(0, 8)}... (reason: ${reason || 'none'})`);
  }

  /**
   * Check if token is blacklisted
   */
  async isBlacklisted(jti: string): Promise<boolean> {
    if (!jti) return false;

    if (this.useRedis && this.redis) {
      const key = `${this.keyPrefix}${jti}`;
      const exists = await this.redis.exists(key);
      return exists === 1;
    }

    const entry = this.store.get(jti);
    if (!entry) return false;

    // Check if expired (should be auto-cleaned, but double-check)
    if (Date.now() > entry.expiresAt) {
      this.store.delete(jti);
      return false;
    }

    return true;
  }

  /**
   * Remove expired entries
   */
  async cleanup(): Promise<number> {
    if (this.useRedis) {
      // Redis handles TTL automatically
      return 0;
    }

    const now = Date.now();
    let cleaned = 0;

    for (const [jti, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(jti);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired blacklist entries`);
    }

    return cleaned;
  }

  /**
   * Blacklist all tokens for a user
   * Requires JWT to include user ID in payload
   */
  async blacklistUserTokens(
    userId: string,
    expiresAt: Date,
    reason?: string,
  ): Promise<void> {
    // Store user-level blacklist marker
    const userKey = `user:${userId}`;

    if (this.useRedis && this.redis) {
      const ttlMs = expiresAt.getTime() - Date.now();
      if (ttlMs > 0) {
        const key = `${this.keyPrefix}${userKey}`;
        await this.redis.setex(key, Math.ceil(ttlMs / 1000), JSON.stringify({
          userId,
          blacklistedAt: Date.now(),
          reason,
        }));
      }
    } else {
      this.store.set(userKey, {
        jti: userKey,
        expiresAt: expiresAt.getTime(),
        reason,
        blacklistedAt: Date.now(),
      });
    }

    this.logger.log(`All tokens blacklisted for user: ${userId} (reason: ${reason || 'none'})`);
  }

  /**
   * Check if all user tokens are blacklisted
   */
  async isUserBlacklisted(userId: string, tokenIssuedAt: Date): Promise<boolean> {
    const userKey = `user:${userId}`;

    if (this.useRedis && this.redis) {
      const key = `${this.keyPrefix}${userKey}`;
      const data = await this.redis.get(key);
      if (!data) return false;

      try {
        const entry = JSON.parse(data);
        // Token is blacklisted if it was issued before the blacklist entry
        return tokenIssuedAt.getTime() < entry.blacklistedAt;
      } catch {
        return false;
      }
    }

    const entry = this.store.get(userKey);
    if (!entry) return false;

    return tokenIssuedAt.getTime() < entry.blacklistedAt;
  }

  /**
   * Composite check: validates a token is not individually blacklisted
   * AND the user's tokens have not been bulk-invalidated.
   *
   * Auth guards should call this single method to ensure both checks
   * are always performed.
   *
   * @returns true if the token is valid (not blacklisted), false if invalid
   */
  async isValidToken(jti: string, userId: string, issuedAt: Date): Promise<boolean> {
    if (!jti || !userId) return false;

    // Check individual token blacklist
    const tokenBlacklisted = await this.isBlacklisted(jti);
    if (tokenBlacklisted) return false;

    // Check user-level blacklist
    const userBlacklisted = await this.isUserBlacklisted(userId, issuedAt);
    if (userBlacklisted) return false;

    return true;
  }

  /**
   * Get blacklist statistics
   */
  getStats(): { totalEntries: number; storageType: string } {
    return {
      totalEntries: this.store.size,
      storageType: this.useRedis ? 'redis' : 'in-memory',
    };
  }

  /**
   * Remove a token from blacklist (use with caution)
   */
  async remove(jti: string): Promise<boolean> {
    if (this.useRedis && this.redis) {
      const key = `${this.keyPrefix}${jti}`;
      const deleted = await this.redis.del(key);
      return deleted > 0;
    }

    return this.store.delete(jti);
  }
}
