import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import { InMemoryRateLimitStore } from './in-memory-rate-limit.store';
import {
  RATE_LIMIT_CONFIG_KEY,
  RATE_LIMIT_STORE,
  RateLimitEntry,
  RateLimitIdentity,
  RateLimitRouteConfig,
  RateLimitStore,
} from './rate-limit.types';

/** Minimal request surface the guard reads — HTTP and GraphQL both map to it. */
interface RateLimitedRequest {
  ip?: string;
  user?: { sub?: string; tenantId?: string };
  body?: Record<string, unknown>;
  res?: {
    setHeader?: (name: string, value: string) => void;
  };
}

/**
 * Platform rate-limit guard (SEC-CRITICAL-002 / ADR-008 defense-in-depth).
 *
 * Explicit-config mode: only handlers carrying @RateLimit(...) are limited —
 * every limited surface is therefore visible in code review and reflectable
 * in tests. Identity dimension precedence inside a bucket:
 *
 *   custom identifier (e.g. login email)  >  user  >  tenant+ip  >  ip
 *
 * Fail-closed policy: in production, when a DISTRIBUTED store was wired and
 * is unhealthy, auth-class buckets must refuse rather than silently allow
 * unlimited traffic (503). Outside production the guard degrades to the
 * in-process fallback store so local development keeps working.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly fallbackStore = new InMemoryRateLimitStore();
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(RATE_LIMIT_STORE)
    private readonly distributedStore?: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<RateLimitRouteConfig | undefined>(
      RATE_LIMIT_CONFIG_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Explicit-config mode: nothing declared, nothing limited here.
    if (!config) {
      return true;
    }

    const { request, args } = this.extractRequest(context);
    const key = this.buildKey(config, request, args);

    let entry: RateLimitEntry;
    try {
      entry = (await this.store().incrementOrCreate(key, config.windowMs)).entry;
    } catch (error) {
      if (this.isProduction && this.distributedStore) {
        // WHY fail-closed: these buckets protect login/MFA/reset — an
        // attacker who can degrade Redis must not thereby unlock unlimited
        // credential stuffing (fail-open would convert an availability
        // incident into a security incident).
        this.logger.error(
          `Rate-limit store unavailable — failing CLOSED for bucket '${config.name}': ${(error as Error).message}`,
        );
        throw new ServiceUnavailableException({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Service temporarily unavailable',
        });
      }
      // Non-production: degrade to the in-process window so development
      // does not require Redis. The degradation is logged, never silent.
      this.logger.warn(
        `Rate-limit store unavailable — using in-process fallback for '${config.name}'`,
      );
      entry = (await this.fallbackStore.incrementOrCreate(key, config.windowMs)).entry;
    }

    this.setInformationalHeaders(request, config, entry);

    if (entry.count > config.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetTime - Date.now()) / 1000));
      // WHY header + body: RFC 6585 clients and proxies act on the
      // Retry-After HEADER; the body copy serves human debugging.
      request.res?.setHeader?.('Retry-After', retryAfterSeconds.toString());

      this.logger.warn(
        `Rate limit exceeded for bucket '${config.name}' (${entry.count}/${config.limit})`,
      );

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests',
          retryAfter: retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private store(): RateLimitStore {
    if (this.distributedStore?.isHealthy()) {
      return this.distributedStore;
    }
    if (this.distributedStore && this.isProduction) {
      // Surface the unhealthy distributed store to the fail-closed branch
      // in canActivate by returning it anyway — its next call will throw.
      return this.distributedStore;
    }
    return this.distributedStore ?? this.fallbackStore;
  }

  /**
   * WHY both transports: auth mutations are GraphQL while file/REST paths are
   * HTTP — one guard must read either context without the caller caring.
   */
  private extractRequest(context: ExecutionContext): {
    request: RateLimitedRequest;
    args?: Record<string, unknown>;
  } {
    if (context.getType<string>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const request = gqlContext.getContext<{ req?: RateLimitedRequest }>().req ?? {};
      return { request, args: gqlContext.getArgs<Record<string, unknown>>() };
    }
    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    return { request, args: request.body };
  }

  private buildKey(
    config: RateLimitRouteConfig,
    request: RateLimitedRequest,
    args?: Record<string, unknown>,
  ): string {
    const identity: RateLimitIdentity = {
      // SECURITY: request.ip is the trust-proxy-resolved address — never
      // read x-forwarded-for directly (client-spoofable).
      ip: request.ip,
      userId: request.user?.sub,
      tenantId: request.user?.tenantId,
      args,
    };

    const custom = config.identifier?.(identity);
    if (custom) {
      return `${config.name}:id:${custom}`;
    }
    if (identity.userId) {
      return `${config.name}:user:${identity.userId}`;
    }
    if (identity.tenantId && identity.ip) {
      return `${config.name}:tenant:${identity.tenantId}:${identity.ip}`;
    }
    return `${config.name}:ip:${identity.ip ?? 'unknown'}`;
  }

  private setInformationalHeaders(
    request: RateLimitedRequest,
    config: RateLimitRouteConfig,
    entry: RateLimitEntry,
  ): void {
    const setHeader = request.res?.setHeader;
    if (!setHeader) {
      return;
    }
    setHeader.call(request.res, 'X-RateLimit-Limit', config.limit.toString());
    setHeader.call(
      request.res,
      'X-RateLimit-Remaining',
      Math.max(0, config.limit - entry.count).toString(),
    );
    setHeader.call(
      request.res,
      'X-RateLimit-Reset',
      Math.ceil(entry.resetTime / 1000).toString(),
    );
  }
}
