import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';

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
 * Rate limit entry tracking
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Simple Rate Limit Guard for REST endpoints
 * Uses in-memory storage with automatic cleanup
 *
 * Default: 10 requests per minute (brute-force protection)
 *
 * Use @RateLimit() decorator to customize per endpoint
 */
@Injectable()
export class SimpleRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(SimpleRateLimitGuard.name);
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  // Default limits for public endpoints (conservative for security)
  private readonly defaultLimit = 10;
  private readonly defaultWindowMs = 60000; // 1 minute

  constructor(private readonly reflector: Reflector) {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const key = this.generateKey(request);
    const config = this.getRateLimitConfig(context);

    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || now > entry.resetTime) {
      // Create new entry
      entry = {
        count: 1,
        resetTime: now + config.windowMs,
      };
      this.store.set(key, entry);
      this.setRateLimitHeaders(response, config, entry);
      return true;
    }

    // Increment count
    entry.count++;
    this.store.set(key, entry);
    this.setRateLimitHeaders(response, config, entry);

    if (entry.count > config.limit) {
      this.logger.warn(
        `Rate limit exceeded for ${key}: ${entry.count}/${config.limit}`,
      );

      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

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

  private generateKey(request: Request): string {
    // Use IP address for rate limiting
    const forwardedFor = request.headers['x-forwarded-for'];
    const ip =
      request.ip ||
      (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0]?.trim() : undefined) ||
      request.socket?.remoteAddress ||
      'unknown';

    // Include path to allow different limits per endpoint
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

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.resetTime) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}
