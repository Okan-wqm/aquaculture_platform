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
import {
  RateLimitAuthorityUnavailableError,
  RateLimitEnforcementService,
} from './rate-limit-enforcement.service';
import {
  EdgeRequestFacts,
  RATE_LIMIT_CONFIG_KEY,
  RATE_LIMIT_EDGE_CONFIG,
  RateLimitEdgeConfig,
  RateLimitEntry,
  RateLimitIdentity,
  RateLimitRouteConfig,
} from './rate-limit.types';

/** Minimal request surface the guard reads — HTTP and GraphQL both map to it. */
interface RateLimitedRequest {
  ip?: string;
  method?: string;
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
 * Fail-closed policy: production always requires the distributed authority,
 * whether it is absent or unhealthy. Individual security policies may require
 * it in every environment. Only non-production, non-required policies may use
 * the bounded in-process development store.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly isProduction = process.env['NODE_ENV'] === 'production';

  constructor(
    private readonly reflector: Reflector,
    private readonly enforcement: RateLimitEnforcementService,
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

    let edgeRuleNames = new Set<string>();
    if (this.edgeConfig) {
      edgeRuleNames = await this.enforceEdge(ctx, this.edgeConfig);
    }

    // Decorator policy is ADDITIVE to the application edge policy. A method-
    // level decorator can narrow a route further, but can never replace the
    // global identity or mutation budgets.
    if (decoratorConfig && !edgeRuleNames.has(decoratorConfig.name)) {
      await this.enforceRule(ctx, decoratorConfig, false, true);
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
  ): Promise<Set<string>> {
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
      await this.enforceRule(ctx, rule, i > 0 && ctx.isGraphql, i === 0, identity);
    }
    return new Set(rules.map((rule) => rule.name));
  }

  private async enforceRule(
    ctx: RequestContext,
    config: RateLimitRouteConfig,
    asGraphqlError: boolean,
    setHeaders: boolean,
    identity: RateLimitIdentity = this.identityOf(ctx.request, ctx.args),
  ): Promise<void> {
    try {
      const evaluation = await this.enforcement.evaluate(config, identity);
      if (setHeaders) {
        this.setInformationalHeaders(ctx.request, config, evaluation.entry);
      }
      this.rejectIfOver(ctx.request, config, evaluation.entry, asGraphqlError);
    } catch (error) {
      if (error instanceof RateLimitAuthorityUnavailableError) {
        throw new ServiceUnavailableException({
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Service temporarily unavailable',
        });
      }
      throw error;
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

  /**
   * WHY both transports: auth mutations are GraphQL while file/REST paths are
   * HTTP — one guard must read either context without the caller caring. The
   * GraphQL parent-type name feeds the edge mutation rule.
   */
  private extractContext(context: ExecutionContext): RequestContext {
    if (context.getType<string>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const request = gqlContext.getContext<{ req?: RateLimitedRequest }>().req ?? {};
      const info = gqlContext.getInfo<{ parentType?: { name?: string } } | undefined>();
      return {
        request,
        args: gqlContext.getArgs<Record<string, unknown>>(),
        isGraphql: true,
        graphqlParentType: info?.parentType?.name,
      };
    }
    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    return { request, args: request.body, isGraphql: false };
  }

  private buildEdgeFacts(ctx: RequestContext): EdgeRequestFacts {
    const req = ctx.request;
    return {
      url: req.url,
      method: req.method,
      headers: req.headers ?? {},
      ip: req.ip,
      remoteAddress: req.connection?.remoteAddress ?? req.socket?.remoteAddress,
      userId: req.user?.sub,
      tenantId: req.user?.tenantId,
      graphqlParentType: ctx.graphqlParentType,
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
