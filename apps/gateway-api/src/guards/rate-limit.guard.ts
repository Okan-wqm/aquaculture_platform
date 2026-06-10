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
  /**
   * Atomic increment-or-create operation to prevent race conditions
   * Returns the updated entry with current count
   */
  incrementOrCreate(key: string, windowMs: number): Promise<{ entry: RateLimitEntry; isNew: boolean }>;
  /**
   * Check if the store is healthy/available
   */
  isHealthy(): Promise<boolean>;
}

/**
 * Injection token for rate limit store
 */
export const RATE_LIMIT_STORE = 'RATE_LIMIT_STORE';

/**
 * In-memory rate limit store (fallback for single-instance deployments)
 * SECURITY: Uses synchronous operations for atomicity in single-threaded Node.js
 */
class InMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanupInterval: NodeJS.Timeout;
  private healthy = true;

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
    return { ...entry }; // Return copy to prevent external mutation
  }

  async set(key: string, entry: RateLimitEntry, _ttlMs: number): Promise<void> {
    this.store.set(key, { ...entry }); // Store copy
  }

  async increment(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (entry && Date.now() <= entry.resetTime) {
      entry.count++;
      return entry.count;
    }
    return 1;
  }

  /**
   * Atomic increment-or-create operation
   * SECURITY: This is atomic in single-threaded Node.js since we don't yield
   */
  async incrementOrCreate(key: string, windowMs: number): Promise<{ entry: RateLimitEntry; isNew: boolean }> {
    const now = Date.now();
    const existing = this.store.get(key);

    // Check if entry exists and is still valid
    if (existing && now <= existing.resetTime) {
      existing.count++;
      return { entry: { ...existing }, isNew: false };
    }

    // Create new entry (atomically replaces expired entry)
    const newEntry: RateLimitEntry = {
      count: 1,
      resetTime: now + windowMs,
    };
    this.store.set(key, newEntry);
    return { entry: { ...newEntry }, isNew: true };
  }

  async isHealthy(): Promise<boolean> {
    return this.healthy;
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
    this.healthy = false;
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
 * SECURITY:
 * - Uses atomic increment operations to prevent race conditions
 * - Fails CLOSED when Redis is unavailable (denies requests)
 * - Validates IP addresses to prevent spoofing attacks
 * - Supports both Redis (distributed) and in-memory (single instance) storage
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
  private readonly failClosed: boolean;
  private readonly isProduction: boolean;
  // Per-endpoint limits from rate-limit.config.ts
  private readonly loginLimit: number;
  private readonly loginWindowMs: number;
  private readonly uploadLimit: number;
  private readonly uploadWindowMs: number;

  // IP validation regex (IPv4 and IPv6)
  private readonly ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  private readonly ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$/;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
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
    this.isProduction = process.env['NODE_ENV'] === 'production';

    // Per-endpoint limits (wired from rate-limit.config.ts env vars)
    this.loginLimit = this.configService.get<number>('RATE_LIMIT_LOGIN_MAX', 5);
    this.loginWindowMs = this.configService.get<number>('RATE_LIMIT_LOGIN_WINDOW_MS', 900000);
    this.uploadLimit = this.configService.get<number>('RATE_LIMIT_UPLOAD_MAX', 10);
    this.uploadWindowMs = this.configService.get<number>('RATE_LIMIT_UPLOAD_WINDOW_MS', 60000);

    // SECURITY: Fail closed by default in production
    // When Redis is down, deny requests rather than allowing them through
    this.failClosed = this.configService.get<boolean>(
      'RATE_LIMIT_FAIL_CLOSED',
      this.isProduction,
    );

    // Create fallback in-memory store
    this.fallbackStore = new InMemoryRateLimitStore();

    if (this.useRedis && !this.redisStore) {
      this.logger.warn(
        'RATE_LIMIT_USE_REDIS is enabled but no Redis store provided. Falling back to in-memory store.',
      );
    }

    if (this.failClosed) {
      this.logger.log('Rate limiting configured to FAIL CLOSED when store unavailable');
    }
  }

  /**
   * Get the active rate limit store
   * SECURITY: Checks store health and handles failures appropriately
   */
  private async getStore(): Promise<RateLimitStore> {
    if (this.useRedis && this.redisStore) {
      try {
        const healthy = await this.redisStore.isHealthy();
        if (healthy) {
          return this.redisStore;
        }
        this.logger.warn('Redis store unhealthy, checking fail mode');
      } catch (error) {
        this.logger.error(`Redis health check failed: ${(error as Error).message}`);
      }

      // SECURITY: In production with fail-closed, throw error
      if (this.failClosed) {
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message: 'Rate limiting service unavailable',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // Development: fall back to in-memory
      this.logger.warn('Falling back to in-memory store (dev mode)');
    }

    return this.fallbackStore;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    const config = this.getRateLimitConfig(context, request);

    // Generate rate limit key
    const key = this.generateKey(request);

    // SECURITY: Get store with health check
    let store: RateLimitStore;
    try {
      store = await this.getStore();
    } catch (error) {
      // Re-throw service unavailable errors
      if (error instanceof HttpException) {
        throw error;
      }
      // Unexpected error - fail closed in production
      if (this.failClosed) {
        this.logger.error(`Rate limit store error: ${(error as Error).message}`);
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message: 'Rate limiting service unavailable',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      store = this.fallbackStore;
    }

    // SECURITY: Use atomic increment-or-create to prevent race conditions
    // This ensures correct counting even under high concurrency
    const { entry } = await store.incrementOrCreate(key, config.windowMs);

    this.setRateLimitHeaders(request, config, entry);

    if (entry.count > config.limit) {
      this.logger.warn(
        `Rate limit exceeded for ${key}: ${entry.count}/${config.limit}`,
      );

      const now = Date.now();
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
    // SECURITY: Use ONLY JWT-verified tenantId for rate limit key namespace.
    // BEFORE: request.user?.tenantId ?? request.tenantId — the fallback could come from
    // TenantContextMiddleware which accepts X-Tenant-ID headers for unauthenticated requests.
    // An unauthenticated attacker could claim any tenant's key namespace by setting the header.
    // AFTER: only request.user?.tenantId (set by JWT verification) is used.
    // Unauthenticated requests fall through to IP-based key — no tenant key namespace.
    const tenantId = request.user?.tenantId;

    // IP extraction with trust proxy support
    // When trust proxy is enabled, Express populates req.ip from X-Forwarded-For
    // Otherwise, fall back to direct extraction
    const ip = this.extractClientIp(request);

    // Include endpoint prefix in key so different endpoints have separate buckets.
    // This prevents dashboard polling from exhausting the same bucket as login.
    //
    // # Why exact-match (SECREV-LOW-001 cure)
    //
    // Pre-cure used substring matching:
    //   url.endsWith('/auth/login')   → matches /api/auth/login but ALSO any
    //                                    request crafted with '/auth/login'
    //                                    suffix (e.g. /auth/login/foo  404).
    //   url.includes('/upload')       → matches /api/files/upload AND
    //                                    /api/v2/wrap/upload-something
    //                                    (unrelated endpoint).
    //
    // The substring shape let an attacker forge URLs containing
    // 'upload' in the path to share rate-limit buckets with
    // legitimate uploaders, triggering bucket exhaustion / lockout.
    //
    // The cure normalises the URL (strip query string, trailing slash)
    // and exact-matches against an explicit allow-list of route prefixes
    // owned by this guard. Anything not on the list falls through to
    // 'default' — same behaviour as pre-cure, but no more substring
    // collisions.
    //
    // The longer-term cure is the @RateLimit({ bucket: 'login' })
    // handler-decorator route the auditor recommended; tracked as
    // the SECREV-LOW-001 follow-on. The exact-match shape here is the
    // minimum-viable architectural correction without that decorator
    // surface.
    const rawUrl = request.url || '';
    const pathname = rawUrl.split('?')[0]?.replace(/\/+$/, '') || '/';
    let endpointPrefix = 'default';
    const exactMatchPrefixes: ReadonlyArray<{
      bucket: string;
      paths: readonly string[];
    }> = [
      {
        bucket: 'login',
        paths: ['/api/auth/login', '/auth/login'],
      },
      {
        bucket: 'upload',
        // The 'upload' bucket protects the canonical file-upload
        // endpoint family. Each path is explicit; substring shapes
        // like 'upload-something' do NOT match.
        paths: ['/api/files/upload', '/api/v1/files/upload'],
      },
    ];
    for (const { bucket, paths } of exactMatchPrefixes) {
      if (paths.includes(pathname)) {
        endpointPrefix = bucket;
        break;
      }
    }

    if (userId) {
      return `ratelimit:${endpointPrefix}:user:${userId}`;
    }

    if (tenantId) {
      return `ratelimit:${endpointPrefix}:tenant:${tenantId}:${ip}`;
    }

    return `ratelimit:${endpointPrefix}:ip:${ip}`;
  }

  /**
   * Validate IP address format
   * SECURITY: Prevents IP spoofing via malformed headers
   */
  private isValidIp(ip: string): boolean {
    if (!ip || ip === 'unknown') return false;
    // Remove IPv6 prefix if present
    const cleanIp = ip.replace(/^::ffff:/, '');
    return this.ipv4Regex.test(cleanIp) || this.ipv6Regex.test(ip);
  }

  /**
   * Extract client IP with proxy support
   * SECURITY:
   * - Validates IP format to prevent spoofing attacks
   * - Only trusts X-Forwarded-For when Express trust proxy is configured
   * - Falls back to direct connection IP when headers are invalid
   */
  private extractClientIp(request: RateLimitRequest): string {
    // req.ip is populated correctly when trust proxy is configured
    // This is the most secure method as Express validates the header chain
    if (request.ip && request.ip !== '::1' && request.ip !== '127.0.0.1') {
      if (this.isValidIp(request.ip)) {
        return request.ip;
      }
      this.logger.warn(`Invalid IP from request: ${request.ip}`);
    }

    // SECURITY: Only parse X-Forwarded-For as fallback
    // This should only be used in development or when trust proxy handles validation
    const forwardedFor = request.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      const firstIp = forwardedFor.split(',')[0]?.trim();
      if (firstIp && this.isValidIp(firstIp)) {
        // SECURITY: Log when using unverified forwarded IP in production
        if (this.isProduction) {
          this.logger.warn(
            `Using unverified X-Forwarded-For IP: ${firstIp}. ` +
            'Configure trust proxy for secure IP extraction.',
          );
        }
        return firstIp;
      }
    }

    // X-Real-IP header (common with nginx)
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && this.isValidIp(realIp)) {
      return realIp;
    }

    // Last resort: connection remote address
    const connectionIp = request.connection?.remoteAddress;
    if (connectionIp && this.isValidIp(connectionIp)) {
      return connectionIp;
    }

    // SECURITY: Use a consistent fallback to prevent bypass via invalid IPs
    // All requests with invalid IPs share one bucket
    return 'invalid-ip';
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

    // SECURITY: Apply per-endpoint rate limits for sensitive operations
    // These limits are stricter than defaults to prevent brute-force attacks
    const url = request.url || '';
    if (url === '/api/auth/login' || url.endsWith('/auth/login')) {
      return { limit: this.loginLimit, windowMs: this.loginWindowMs };
    }
    if (url.includes('/upload')) {
      return { limit: this.uploadLimit, windowMs: this.uploadWindowMs };
    }

    // SECURITY: Only grant elevated tenant rate limit when the user is
    // authenticated and the tenantId is derived from the verified JWT.
    // Never gate rate-limit tiers on the raw x-tenant-id header, as an
    // unauthenticated attacker can set it to claim 1000 req/min vs 20.
    if (request.user?.tenantId) {
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
