import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Response } from 'express';

import { THROTTLE_KEY, THROTTLE_SKIP_KEY, ThrottleOptions } from './throttler.decorator';
import { SlidingWindowStrategy } from './sliding-window.strategy';
import { IIpValidator, IP_VALIDATOR } from '../interfaces';
import { SecurityEventService } from '../security-event.service';
import { TenantRequest } from '../../types/tenant-request.interface';

// The throttler READER consumes the platform-canonical request-user SSoT
// (TenantRequest.user: JwtUser, identity = `sub`). It deliberately does NOT
// define a private `{ sub?, userId? }` shape — a private looser type is exactly
// what let admin-api attach `{ id }` (no `sub`) and be silently throttled as
// anonymous (ORPHAN-145/146). Binding to JwtUser makes `sub` the one identity
// field every auth guard/middleware writer must provide.

/**
 * Throttler Guard
 *
 * Implements configurable rate limiting with:
 * - Per-user rate limiting (authenticated requests)
 * - Per-IP rate limiting (anonymous requests or when byIp is true)
 * - Per-tenant rate limiting
 * - Sliding window algorithm for accurate rate limiting
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles rate limit enforcement
 * - Open/Closed: Configurable via decorators
 * - Dependency Inversion: Uses injected strategy
 */
@Injectable()
export class ThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(ThrottlerGuard.name);
  private readonly defaultLimit: number;
  private readonly defaultTtl: number;
  private readonly anonymousLimit: number;
  private readonly isEnabled: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly rateLimiter: SlidingWindowStrategy,
    @Optional() @Inject(IP_VALIDATOR) private readonly ipValidator?: IIpValidator,
    // SEC-HIGH-010 cure: rate-limit hits are a security signal —
    // brute-force attacks, runaway clients, DoS attempts. The
    // canonical SecurityEventService publishes the event into the
    // platform's incident-detection pipeline (Prom alert / pager /
    // SIEM) in real time. @Optional preserves local-dev paths where
    // the security infrastructure may not be wired.
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    this.defaultLimit = this.configService.get<number>('THROTTLE_DEFAULT_LIMIT', 100);
    this.defaultTtl = this.configService.get<number>('THROTTLE_DEFAULT_TTL', 60);
    this.anonymousLimit = this.configService.get<number>('THROTTLE_ANONYMOUS_LIMIT', 20);
    this.isEnabled = this.configService.get<boolean>('THROTTLE_ENABLED', true);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if throttling is enabled
    if (!this.isEnabled) {
      return true;
    }

    // Check if route should skip throttling
    const shouldSkip = this.reflector.getAllAndOverride<boolean>(THROTTLE_SKIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (shouldSkip) {
      return true;
    }

    const request = this.getRequest(context);
    const response = this.getResponse(context);
    const config = this.getThrottleConfig(context, request);

    // Generate rate limit key
    const key = this.generateKey(request, config);
    const windowMs = config.ttl * 1000;

    // Check rate limit
    const result = await this.rateLimiter.consumeWithConfig(
      key,
      config.limit,
      windowMs,
    );

    // Set rate limit headers
    this.setHeaders(response, config, result.remaining, result.resetTime);

    if (!result.allowed) {
      this.logger.warn(
        `Rate limit exceeded for ${key}: ${config.limit} requests in ${config.ttl}s`,
      );

      // SEC-HIGH-010 cure: publish RateLimitExceeded SecurityEvent so
      // the incident-detection pipeline sees the signal in real time.
      // Defensive try/catch — a downstream event-bus outage MUST NOT
      // block the 429 response (otherwise a failed event publish
      // becomes a request-storm DOS lever). We pass the rate-key as
      // the canonical identifier; downstream alert rules typically
      // filter on key prefix (e.g. throttle:ip vs throttle:user) to
      // distinguish brute-force vs runaway-client patterns.
      try {
        await this.securityEventService?.publishRateLimitExceeded({
          ip: this.extractClientIp(request),
          userId: request.user?.sub,
          tenantId: request.tenantId ?? request.user?.tenantId,
          key,
          limit: config.limit,
          windowMs,
          count: config.limit + 1,
        });
      } catch (err) {
        this.logger.warn(
          `RateLimitExceeded SecurityEvent publish failed (non-fatal): ${
            err instanceof Error ? err.message : 'Unknown'
          }`,
        );
      }

      const errorMessage = config.errorMessage || 'Too many requests. Please try again later.';

      // IMPORTANT: Set Retry-After header BEFORE throwing so the exception filter
      // does not need to know about rate limiting internals. RFC 6585 §4 requires
      // 429 responses to include Retry-After so clients can implement correct backoff.
      const retryAfterSeconds = result.retryAfter ?? Math.ceil(config.ttl);
      if (response?.setHeader) {
        response.setHeader('Retry-After', retryAfterSeconds.toString());
      }

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: errorMessage,
          error: 'Too Many Requests',
          retryAfter: retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Extract request from context (REST or GraphQL)
   */
  private getRequest(context: ExecutionContext): TenantRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      return gqlContext.getContext().req as TenantRequest;
    }

    return context.switchToHttp().getRequest<TenantRequest>();
  }

  /**
   * Extract response from context
   */
  private getResponse(context: ExecutionContext): Response | null {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const ctx = gqlContext.getContext();
      return ctx.res || ctx.req?.res || null;
    }

    return context.switchToHttp().getResponse<Response>();
  }

  /**
   * Get throttle configuration from decorator or defaults
   */
  private getThrottleConfig(
    context: ExecutionContext,
    request: TenantRequest,
  ): ThrottleOptions {
    const decoratorConfig = this.reflector.getAllAndOverride<ThrottleOptions>(THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (decoratorConfig) {
      return decoratorConfig;
    }

    // Use stricter limits for anonymous users
    const isAuthenticated = !!request.user?.sub;

    return {
      limit: isAuthenticated ? this.defaultLimit : this.anonymousLimit,
      ttl: this.defaultTtl,
    };
  }

  /**
   * Generate rate limit key based on configuration
   */
  private generateKey(request: TenantRequest, config: ThrottleOptions): string {
    const prefix = config.keyPrefix || 'throttle';
    const ip = this.extractClientIp(request);

    // IP-based rate limiting
    if (config.byIp) {
      return `${prefix}:ip:${ip}`;
    }

    // User-based rate limiting
    const userId = request.user?.sub;
    if (userId) {
      return `${prefix}:user:${userId}`;
    }

    // Tenant-based for authenticated requests without user ID
    const tenantId = request.tenantId || request.user?.tenantId;
    if (tenantId) {
      return `${prefix}:tenant:${tenantId}:${ip}`;
    }

    // Fall back to IP for anonymous requests
    return `${prefix}:ip:${ip}`;
  }

  /**
   * Extract client IP with validation
   */
  private extractClientIp(request: TenantRequest): string {
    // Use injected IP validator if available
    if (this.ipValidator) {
      return this.ipValidator.extractClientIp({
        ip: request.ip ?? request.socket?.remoteAddress ?? 'unknown',
        headers: request.headers as Record<string, string | string[] | undefined>,
        connection: request.connection,
        socket: request.socket,
      });
    }

    // Fallback implementation
    // Trust req.ip when trust proxy is configured
    if (request.ip && this.isValidIp(request.ip)) {
      return request.ip;
    }

    // X-Forwarded-For header
    const forwardedFor = request.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      const firstIp = forwardedFor.split(',')[0]?.trim();
      if (firstIp && this.isValidIp(firstIp)) {
        return firstIp;
      }
    }

    // X-Real-IP header (nginx)
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && this.isValidIp(realIp)) {
      return realIp;
    }

    // Connection remote address
    const connectionIp = request.connection?.remoteAddress || request.socket?.remoteAddress;
    if (connectionIp && this.isValidIp(connectionIp)) {
      return connectionIp;
    }

    // Return a fallback to prevent bypass via invalid IPs
    return 'unknown-ip';
  }

  /**
   * Basic IP validation
   */
  private isValidIp(ip: string): boolean {
    if (!ip || ip === 'unknown') return false;

    // Remove IPv6 prefix
    const cleanIp = ip.replace(/^::ffff:/, '');

    // IPv4 regex
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

    // Simple IPv6 check
    const ipv6Regex = /^[0-9a-fA-F:]+$/;

    return ipv4Regex.test(cleanIp) || ipv6Regex.test(ip);
  }

  /**
   * Set rate limit headers on response
   */
  private setHeaders(
    response: Response | null,
    config: ThrottleOptions,
    remaining: number,
    resetTime: Date,
  ): void {
    if (!response?.setHeader) return;

    response.setHeader('X-RateLimit-Limit', config.limit.toString());
    response.setHeader('X-RateLimit-Remaining', Math.max(0, remaining).toString());
    response.setHeader('X-RateLimit-Reset', Math.ceil(resetTime.getTime() / 1000).toString());
    response.setHeader('X-RateLimit-Policy', `${config.limit};w=${config.ttl}`);
  }
}
