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
import { GqlExecutionContext } from '@nestjs/graphql';
import { ConfigService } from '@nestjs/config';

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
export const RateLimit = (config: RateLimitConfig) =>
  SetMetadata(RATE_LIMIT_KEY, config);

/**
 * Rate limit entry
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Rate Limit Guard
 * Implements token bucket algorithm for rate limiting
 * Supports per-tenant, per-user, and per-IP rate limiting
 * Enterprise-grade with configurable limits per endpoint
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;

  // Default limits
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  private readonly tenantLimit: number;
  private readonly anonymousLimit: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
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

    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      60000,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    const key = this.generateKey(request);
    const config = this.getRateLimitConfig(context, request);

    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || now > entry.resetTime) {
      // Create new entry
      entry = {
        count: 1,
        resetTime: now + config.windowMs,
      };
      this.store.set(key, entry);
      this.setRateLimitHeaders(request, config, entry);
      return true;
    }

    // Increment count
    entry.count++;
    this.store.set(key, entry);
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

  private getRequest(context: ExecutionContext): any {
    // Check if it's a GraphQL request
    const gqlContext = GqlExecutionContext.create(context);
    const gqlRequest = gqlContext.getContext()?.req;

    if (gqlRequest) {
      return gqlRequest;
    }

    // Fall back to HTTP request
    return context.switchToHttp().getRequest();
  }

  private generateKey(request: any): string {
    // Priority: user > tenant > IP
    const userId = request.user?.sub || request.userId;
    const tenantId =
      request.tenantId ||
      request.headers?.['x-tenant-id'];
    const ip =
      request.ip ||
      request.headers?.['x-forwarded-for']?.split(',')[0] ||
      request.connection?.remoteAddress;

    if (userId) {
      return `user:${userId}`;
    }

    if (tenantId) {
      return `tenant:${tenantId}:${ip}`;
    }

    return `ip:${ip}`;
  }

  private getRateLimitConfig(
    context: ExecutionContext,
    request: any,
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
    const tenantId = request.tenantId || request.headers?.['x-tenant-id'];
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
    request: any,
    config: RateLimitConfig,
    entry: RateLimitEntry,
  ): void {
    // Get response object to set headers
    const response = request.res;
    if (response?.setHeader) {
      response.setHeader('X-RateLimit-Limit', config.limit);
      response.setHeader(
        'X-RateLimit-Remaining',
        Math.max(0, config.limit - entry.count),
      );
      response.setHeader(
        'X-RateLimit-Reset',
        Math.ceil(entry.resetTime / 1000),
      );
    }
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
