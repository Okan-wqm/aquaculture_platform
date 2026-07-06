import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
  OnModuleDestroy,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  type RateLimitEntry,
  type RateLimitStore,
} from '@aquaculture/backend-common/rate-limit';

/**
 * Metadata key for custom rate limits
 */
export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Rate limit decorator for controllers/handlers
 * @example @RateLimit({ limit: 5, windowMs: 60000 }) // 5 requests per minute
 */
export const RateLimit = (config: RateLimitConfig): ReturnType<typeof SetMetadata> =>
  SetMetadata(RATE_LIMIT_KEY, config);

/**
 * Simple Rate Limit Guard for public REST endpoints (provisioning, activation).
 *
 * SENSOR-LOW-008: counters live in a distributed {@link RateLimitStore} backed
 * by Redis, so every replica enforces ONE shared window per key. A per-instance
 * in-memory Map multiplied every limit by the replica count and reset on each
 * redeploy — brute-force protection you could scale around. The Redis store
 * uses an atomic Lua INCR+PEXPIRE (no read-modify-write race). When no Redis is
 * wired (local/dev) it degrades to the in-process fallback, logged loudly; in
 * production an unreachable store fails CLOSED (429/503) rather than silently
 * disabling protection.
 *
 * Default: 10 requests per minute (brute-force protection). Use @RateLimit() to
 * customise per endpoint.
 */
@Injectable()
export class SimpleRateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(SimpleRateLimitGuard.name);
  private readonly distributedStore?: RateLimitStore;
  private readonly fallbackStore = new InMemoryRateLimitStore();
  private readonly isProduction: boolean;

  // Default limits for public endpoints (conservative for security)
  private readonly defaultLimit = 10;
  private readonly defaultWindowMs = 60000; // 1 minute

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    @Optional() redisService?: RedisService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (redisService) {
      this.distributedStore = new RedisRateLimitStore(redisService, 'sensor:ratelimit:');
    } else {
      this.logger.warn(
        'RedisService unavailable — provisioning rate limiting falls back to per-instance ' +
          'in-memory counters (N replicas => N x limit). Wire Redis for a shared window.',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const key = this.generateKey(request);
    const config = this.getRateLimitConfig(context);

    const entry = await this.countWindow(key, config.windowMs);
    this.setRateLimitHeaders(response, config, entry);

    if (entry.count > config.limit) {
      this.logger.warn(
        `Rate limit exceeded for ${key}: ${entry.count}/${config.limit}`,
      );

      const retryAfter = Math.max(1, Math.ceil((entry.resetTime - Date.now()) / 1000));

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Increment the window for `key`, applying the fail-closed-in-prod policy on
   * store failure (mirrors the platform rate-limit guard).
   */
  private async countWindow(key: string, windowMs: number): Promise<RateLimitEntry> {
    try {
      return (await this.selectStore().incrementOrCreate(key, windowMs)).entry;
    } catch (error) {
      if (this.isProduction && this.distributedStore) {
        // Fail CLOSED: an attacker who can degrade Redis must not thereby unlock
        // unlimited brute-force traffic against provisioning/activation.
        this.logger.error(
          `Rate-limit store unavailable — failing CLOSED: ${(error as Error).message}`,
        );
        throw new HttpException(
          { statusCode: HttpStatus.SERVICE_UNAVAILABLE, message: 'Service temporarily unavailable' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      this.logger.warn(
        `Rate-limit store unavailable — using in-process fallback: ${(error as Error).message}`,
      );
      return (await this.fallbackStore.incrementOrCreate(key, windowMs)).entry;
    }
  }

  private selectStore(): RateLimitStore {
    if (this.distributedStore?.isHealthy()) {
      return this.distributedStore;
    }
    // In production, return the unhealthy distributed store so countWindow's
    // catch fails closed; in dev, degrade to the in-process fallback.
    if (this.distributedStore && this.isProduction) {
      return this.distributedStore;
    }
    return this.distributedStore ?? this.fallbackStore;
  }

  private generateKey(request: Request): string {
    // Only trust request.ip (which Express resolves via trust proxy setting).
    // Manual X-Forwarded-For parsing is a bypass vector - attackers can spoof
    // the header to get a fresh rate limit bucket per request.
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const path = request.path || request.url;
    return `${ip}:${path}`;
  }

  private getRateLimitConfig(context: ExecutionContext): RateLimitConfig {
    // Check for custom rate limit on handler or class
    const customConfig = this.reflector.getAllAndOverride<RateLimitConfig>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (customConfig) {
      return customConfig;
    }

    return {
      limit: this.defaultLimit,
      windowMs: this.defaultWindowMs,
    };
  }

  private setRateLimitHeaders(
    response: Response,
    config: RateLimitConfig,
    entry: RateLimitEntry,
  ): void {
    response.setHeader('X-RateLimit-Limit', config.limit.toString());
    response.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, config.limit - entry.count).toString(),
    );
    response.setHeader(
      'X-RateLimit-Reset',
      Math.ceil(entry.resetTime / 1000).toString(),
    );
  }

  onModuleDestroy(): void {
    // The distributed store's connection lifecycle belongs to RedisService;
    // only the in-process fallback owns a timer that must be released.
    this.fallbackStore.destroy();
    this.distributedStore?.destroy();
  }
}
