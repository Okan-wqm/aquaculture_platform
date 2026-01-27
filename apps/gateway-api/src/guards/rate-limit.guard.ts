import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  SetMetadata,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Response } from 'express';

import { AuthenticatedRequest, GqlContext } from '../types';

/**
 * Metadata key for custom rate limits
 */
export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

/**
 * Rate limit decorator
 */
export const RateLimit = (config: RateLimitConfig): ReturnType<typeof SetMetadata> =>
  SetMetadata(RATE_LIMIT_KEY, config);

/**
 * Rate limit entry
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Extended request with response for rate limiting
 */
interface RateLimitRequest extends Omit<AuthenticatedRequest, 'connection'> {
  res?: Response;
  connection?: { remoteAddress?: string };
  userId?: string;
}

/**
 * Rate limit store interface for pluggable storage backends
 */
export interface RateLimitStore {
  get(key: string): Promise<RateLimitEntry | null>;
  set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void>;
  increment(key: string): Promise<number>;
}

/**
 * Injection token for rate limit store
 */
export const RATE_LIMIT_STORE = 'RATE_LIMIT_STORE';

/**
 * In-memory rate limit store (fallback for single-instance deployments)
 */
class InMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async get(key: string): Promise<RateLimitEntry | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.resetTime) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, entry: RateLimitEntry, _ttlMs: number): Promise<void> {
    this.store.set(key, entry);
  }

  async increment(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (entry) {
      entry.count++;
      return entry.count;
    }
    return 1;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.resetTime) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Rate Limit Guard
 * Implements sliding window algorithm for rate limiting
 * Supports per-tenant, per-user, and per-IP rate limiting
 * Enterprise-grade with configurable limits per endpoint
 *
 * Supports both Redis (distributed) and in-memory (single instance) storage
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly fallbackStore: InMemoryRateLimitStore;

  // Default limits
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  private readonly tenantLimit: number;
  private readonly anonymousLimit: number;
  private readonly useRedis: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    @Optional() @Inject(RATE_LIMIT_STORE) private readonly redisStore?: RateLimitStore,
  ) {
    this.defaultLimit = this.configService.get<number>(
      'RATE_LIMIT_DEFAULT',
      100,
    );
    this.defaultWindowMs = this.configService.get<number>(
      'RATE_LIMIT_WINDOW_MS',
      60000,
    ); // 1 minute
    this.tenantLimit = this.configService.get<number>(
      'RATE_LIMIT_TENANT',
      1000,
    );
    this.anonymousLimit = this.configService.get<number>(
      'RATE_LIMIT_ANONYMOUS',
      20,
    );
    this.useRedis = this.configService.get<boolean>('RATE_LIMIT_USE_REDIS', false);

    // Create fallback in-memory store
    this.fallbackStore = new InMemoryRateLimitStore();

    if (this.useRedis && !this.redisStore) {
      this.logger.warn(
        'RATE_LIMIT_USE_REDIS is enabled but no Redis store provided. Falling back to in-memory store.',
      );
    }
  }

  private get store(): RateLimitStore {
    if (this.useRedis && this.redisStore) {
      return this.redisStore;
    }
    return this.fallbackStore;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    const key = this.generateKey(request);
    const config = this.getRateLimitConfig(context, request);

    const now = Date.now();
    let entry = await this.store.get(key);

    if (!entry || now > entry.resetTime) {
      // Create new entry
      entry = {
        count: 1,
        resetTime: now + config.windowMs,
      };
      await this.store.set(key, entry, config.windowMs);
      this.setRateLimitHeaders(request, config, entry);
      return true;
    }

    // Increment count
    entry.count = await this.store.increment(key);
    this.setRateLimitHeaders(request, config, entry);

    if (entry.count > config.limit) {
      this.logger.warn(
        `Rate limit exceeded for ${key}: ${entry.count}/${config.limit}`,
      );

      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private getRequest(context: ExecutionContext): RateLimitRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext<GqlContext>();
      return ctx.req as RateLimitRequest;
    }

    return context.switchToHttp().getRequest<RateLimitRequest>();
  }

  private generateKey(request: RateLimitRequest): string {
    // Priority: user > tenant > IP
    const userId = request.user?.sub ?? request.userId;
    const tenantIdHeader = request.headers['x-tenant-id'];
    const tenantId = request.tenantId ?? (typeof tenantIdHeader === 'string' ? tenantIdHeader : undefined);

    // IP extraction with trust proxy support
    // When trust proxy is enabled, Express populates req.ip from X-Forwarded-For
    // Otherwise, fall back to direct extraction
    const ip = this.extractClientIp(request);

    if (userId) {
      return `ratelimit:user:${userId}`;
    }

    if (tenantId) {
      return `ratelimit:tenant:${tenantId}:${ip}`;
    }

    return `ratelimit:ip:${ip}`;
  }

  /**
   * Extract client IP with proxy support
   * When behind a reverse proxy (nginx, cloudflare, etc), the real client IP
   * is in X-Forwarded-For header. Express's req.ip handles this when trust proxy is enabled.
   */
  private extractClientIp(request: RateLimitRequest): string {
    // req.ip is populated correctly when trust proxy is configured
    if (request.ip && request.ip !== '::1' && request.ip !== '127.0.0.1') {
      return request.ip;
    }

    // Fallback: manually parse X-Forwarded-For (first IP is client)
    const forwardedFor = request.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      const firstIp = forwardedFor.split(',')[0]?.trim();
      if (firstIp) {
        return firstIp;
      }
    }

    // X-Real-IP header (common with nginx)
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp) {
      return realIp;
    }

    // Last resort: connection remote address or unknown
    return request.connection?.remoteAddress ?? request.ip ?? 'unknown';
  }

  private getRateLimitConfig(
    context: ExecutionContext,
    request: RateLimitRequest,
  ): RateLimitConfig {
    // Check for custom rate limit on handler/class
    const customConfig = this.reflector.getAllAndOverride<RateLimitConfig>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (customConfig) {
      return customConfig;
    }

    // Use tenant limit if authenticated
    const tenantId = request.tenantId ?? request.headers['x-tenant-id'];
    if (tenantId) {
      return {
        limit: this.tenantLimit,
        windowMs: this.defaultWindowMs,
      };
    }

    // Use anonymous limit for unauthenticated requests
    if (!request.user) {
      return {
        limit: this.anonymousLimit,
        windowMs: this.defaultWindowMs,
      };
    }

    return {
      limit: this.defaultLimit,
      windowMs: this.defaultWindowMs,
    };
  }

  private setRateLimitHeaders(
    request: RateLimitRequest,
    config: RateLimitConfig,
    entry: RateLimitEntry,
  ): void {
    // Get response object to set headers
    const response = request.res;
    if (response?.setHeader) {
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
  }

  onModuleDestroy(): void {
    this.fallbackStore.destroy();
  }
}
