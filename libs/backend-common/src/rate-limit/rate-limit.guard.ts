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
import { GraphQLError } from 'graphql';

import { resolveEdgeRules } from './edge/edge-rule-resolver';
import { extractClientIp } from './edge/ip-extractor';
import { InMemoryRateLimitStore } from './in-memory-rate-limit.store';
import {
  EdgeRequestFacts,
  RATE_LIMIT_CONFIG_KEY,
  RATE_LIMIT_EDGE_CONFIG,
  RATE_LIMIT_STORE,
  RateLimitEdgeConfig,
  RateLimitEntry,
  RateLimitIdentity,
  RateLimitRouteConfig,
  RateLimitStore,
} from './rate-limit.types';

/** Minimal request surface the guard reads — HTTP and GraphQL both map to it. */
interface RateLimitedRequest {
  ip?: string;
  /** HTTP request path (edge mode only) — used for exact-match tier bucketing. */
  url?: string;
  /** Header bag (edge mode only) — X-Forwarded-For / X-Real-IP fallback. */
  headers?: Record<string, string | string[] | undefined>;
  /** Socket fallbacks (edge mode only) for client-IP resolution. */
  connection?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
  user?: { sub?: string; tenantId?: string };
  body?: Record<string, unknown>;
  res?: {
    setHeader?: (name: string, value: string) => void;
  };
}

interface RequestContext {
  request: RateLimitedRequest;
  args?: Record<string, unknown>;
  isGraphql: boolean;
  graphqlParentType?: string;
  graphqlFieldName?: string;
}

/**
 * Platform rate-limit guard (SEC-CRITICAL-002 / ADR-008 defense-in-depth).
 *
 * ONE guard, two resolution sources, one atomic counting primitive:
 *
 *  • Decorator mode — handlers carrying @RateLimit(...) are limited by their
 *    explicit config; every limited surface is visible in review and
 *    reflectable in tests. Identity precedence inside a bucket:
 *      custom identifier (e.g. login email)  >  user  >  tenant+ip  >  ip
 *    Services with no edge config (auth-service, every subgraph) use ONLY this
 *    mode — non-decorated handlers fall through to `true`, unchanged.
 *
 *  • Edge mode (D2 / CRITICAL-002) — when an OPTIONAL RateLimitEdgeConfig is
 *    injected (gateway only), a non-decorated request is classified by
 *    exact-match path + JWT identity + GraphQL operation into NAMED TIERS and
 *    counted through the SAME store. GraphQL mutations are bounded ADDITIVELY
 *    by both the identity tier and the mutation tier (mirroring the gateway's
 *    previously-independent MutationRateLimitGuard, now distributed).
 *
 * Fail-closed policy: in production, when a DISTRIBUTED store was wired and is
 * unhealthy, buckets refuse rather than silently allow unlimited traffic (503).
 * Outside production the guard degrades to the in-process fallback store so
 * local development keeps working.
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
    @Optional()
    @Inject(RATE_LIMIT_EDGE_CONFIG)
    private readonly edgeConfig?: RateLimitEdgeConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const decoratorConfig = this.reflector.getAllAndOverride<RateLimitRouteConfig | undefined>(
      RATE_LIMIT_CONFIG_KEY,
      [context.getHandler(), context.getClass()],
    );

    const ctx = this.extractContext(context);

    // Decorator mode — explicit per-route config wins over edge config.
    if (decoratorConfig) {
      const identity = this.identityOf(ctx.request, ctx.args);
      const key = this.buildKey(decoratorConfig, identity);
      const entry = await this.countWindow(key, decoratorConfig.windowMs, decoratorConfig.name);
      this.setInformationalHeaders(ctx.request, decoratorConfig, entry);
      this.rejectIfOver(ctx.request, decoratorConfig, entry, false);
      return true;
    }

    // Edge mode — config-driven tiers (gateway). Absent for decorator-only
    // consumers, so they short-circuit to `true` exactly as before.
    if (this.edgeConfig) {
      return this.enforceEdge(ctx, this.edgeConfig);
    }

    return true;
  }

  /**
   * Edge enforcement: resolve the applicable tiers and count EACH (reject on the
   * first over-limit). The primary identity/endpoint tier sets the
   * informational headers and throws an HTTP 429; an additive GraphQL mutation
   * tier throws a GraphQLError so GraphQL clients keep their error shape.
   */
  private async enforceEdge(
    ctx: RequestContext,
    edgeConfig: RateLimitEdgeConfig,
  ): Promise<boolean> {
    const facts = this.buildEdgeFacts(ctx);
    const extracted = extractClientIp(facts);
    if (extracted.unverifiedForwardedFor && this.isProduction) {
      // WHY warn: an unverified X-Forwarded-For is spoofable — surface the
      // trust-proxy misconfiguration without dropping the request (ported
      // gateway behavior).
      this.logger.warn(
        'Rate-limit IP resolved from an unverified X-Forwarded-For header — configure trust proxy for secure extraction.',
      );
    }
    const identity: RateLimitIdentity = {
      ip: extracted.ip,
      userId: facts.userId,
      tenantId: facts.tenantId,
    };

    const rules = resolveEdgeRules(facts, edgeConfig);
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule) {
        continue;
      }
      const key = this.buildKey(rule, identity);
      const entry = await this.countWindow(key, rule.windowMs, rule.name);
      if (i === 0) {
        // Only the primary tier sets X-RateLimit-* — matches the gateway, where
        // RateLimitGuard set the headers and MutationRateLimitGuard did not.
        this.setInformationalHeaders(ctx.request, rule, entry);
      }
      // Additive mutation tier (i > 0) under GraphQL throws GraphQLError.
      this.rejectIfOver(ctx.request, rule, entry, i > 0 && ctx.isGraphql);
    }
    return true;
  }

  /**
   * Increment the window for `key`, applying the fail-closed policy on store
   * failure. Shared by decorator and edge paths so both fail identically.
   */
  private async countWindow(
    key: string,
    windowMs: number,
    bucketName: string,
  ): Promise<RateLimitEntry> {
    try {
      return (await this.store().incrementOrCreate(key, windowMs)).entry;
    } catch (error) {
      if (this.isProduction && this.distributedStore) {
        // WHY fail-closed: these buckets protect login/MFA/reset/mutations — an
        // attacker who can degrade Redis must not thereby unlock unlimited
        // traffic (fail-open would convert an availability incident into a
        // security incident).
        this.logger.error(
          `Rate-limit store unavailable — failing CLOSED for bucket '${bucketName}': ${(error as Error).message}`,
        );
        throw new ServiceUnavailableException({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Service temporarily unavailable',
        });
      }
      // Non-production: degrade to the in-process window so development does not
      // require Redis. The degradation is logged, never silent.
      this.logger.warn(
        `Rate-limit store unavailable — using in-process fallback for '${bucketName}'`,
      );
      return (await this.fallbackStore.incrementOrCreate(key, windowMs)).entry;
    }
  }

  private rejectIfOver(
    request: RateLimitedRequest,
    config: RateLimitRouteConfig,
    entry: RateLimitEntry,
    asGraphqlError: boolean,
  ): void {
    if (entry.count <= config.limit) {
      return;
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetTime - Date.now()) / 1000));
    this.logger.warn(
      `Rate limit exceeded for bucket '${config.name}' (${entry.count}/${config.limit})`,
    );

    if (asGraphqlError) {
      // Preserve the GraphQL client error shape the gateway's
      // MutationRateLimitGuard produced (extensions.code + retryAfter).
      throw new GraphQLError(
        `Rate limit exceeded. Maximum ${config.limit} per ${Math.ceil(config.windowMs / 1000)}s. Retry after ${retryAfterSeconds} seconds.`,
        {
          extensions: {
            code: 'TOO_MANY_REQUESTS',
            retryAfter: retryAfterSeconds,
          },
        },
      );
    }

    // WHY header + body: RFC 6585 clients and proxies act on the Retry-After
    // HEADER; the body copy serves human debugging.
    request.res?.setHeader?.('Retry-After', retryAfterSeconds.toString());
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests',
        retryAfter: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private store(): RateLimitStore {
    if (this.distributedStore?.isHealthy()) {
      return this.distributedStore;
    }
    if (this.distributedStore && this.isProduction) {
      // Surface the unhealthy distributed store to the fail-closed branch in
      // countWindow by returning it anyway — its next call will throw.
      return this.distributedStore;
    }
    return this.distributedStore ?? this.fallbackStore;
  }

  /**
   * WHY both transports: auth mutations are GraphQL while file/REST paths are
   * HTTP — one guard must read either context without the caller caring. The
   * GraphQL parent-type name feeds the edge mutation rule.
   */
  private extractContext(context: ExecutionContext): RequestContext {
    if (context.getType<string>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const request = gqlContext.getContext<{ req?: RateLimitedRequest }>().req ?? {};
      const info = gqlContext.getInfo<
        { parentType?: { name?: string }; fieldName?: string } | undefined
      >();
      return {
        request,
        args: gqlContext.getArgs<Record<string, unknown>>(),
        isGraphql: true,
        graphqlParentType: info?.parentType?.name,
        graphqlFieldName: info?.fieldName,
      };
    }
    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    return { request, args: request.body, isGraphql: false };
  }

  private buildEdgeFacts(ctx: RequestContext): EdgeRequestFacts {
    const req = ctx.request;
    return {
      url: req.url,
      headers: req.headers ?? {},
      ip: req.ip,
      remoteAddress: req.connection?.remoteAddress ?? req.socket?.remoteAddress,
      userId: req.user?.sub,
      tenantId: req.user?.tenantId,
      graphqlParentType: ctx.graphqlParentType,
      graphqlFieldName: ctx.graphqlFieldName,
    };
  }

  private identityOf(
    request: RateLimitedRequest,
    args?: Record<string, unknown>,
  ): RateLimitIdentity {
    return {
      // SECURITY: request.ip is the trust-proxy-resolved address — never read
      // x-forwarded-for directly here (client-spoofable). The edge path uses
      // the dedicated ip-extractor, which applies the same discipline.
      ip: request.ip,
      userId: request.user?.sub,
      tenantId: request.user?.tenantId,
      args,
    };
  }

  private buildKey(config: RateLimitRouteConfig, identity: RateLimitIdentity): string {
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
    setHeader.call(request.res, 'X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000).toString());
  }
}
