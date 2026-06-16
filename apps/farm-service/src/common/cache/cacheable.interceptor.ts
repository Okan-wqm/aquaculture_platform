/**
 * CacheableInterceptor
 *
 * Reads @Cacheable metadata, computes the Redis key for the method
 * call, serves hits directly, and writes misses through to Redis
 * with the configured TTL. Every read and write is best-effort —
 * a Redis outage never blocks the method; the interceptor logs
 * the failure and falls through to the underlying handler.
 *
 * Phase 7.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { RedisService } from '@aquaculture/backend-common/redis';
import { extractTenantIdSafe } from '@aquaculture/backend-common/decorators';
import { TenantRequest } from '@aquaculture/backend-common/types';
import { createHash } from 'crypto';
import { Observable, from, firstValueFrom } from 'rxjs';

import {
  CACHEABLE_METADATA_KEY,
  CacheableOptions,
} from './cacheable.decorator';

interface ResolvedOptions extends CacheableOptions {
  scopeToTenant: boolean;
}

@Injectable()
export class CacheableInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheableInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const handler = context.getHandler();
    const metadata = this.reflector.get<CacheableOptions | undefined>(
      CACHEABLE_METADATA_KEY,
      handler,
    );
    if (!metadata || !this.redisService) {
      return next.handle();
    }
    const redis = this.redisService;
    const options: ResolvedOptions = {
      scopeToTenant: true,
      ...metadata,
    };

    const key = this.buildKey(context, options);
    if (!key) {
      // Tenant scoping required but missing — skip the cache rather
      // than risk a cross-tenant entry.
      this.logger.warn(
        `Cacheable('${options.prefix}') skipped: tenant-scoped method ` +
          `called without a resolvable tenantId. Method executes without cache.`,
      );
      return next.handle();
    }

    // Single-flight read-through (no-stampede): on a miss, exactly one request
    // recomputes while concurrent requests for the same key wait for its
    // result — so a TTL expiry on a hot key no longer thunders the handler.
    // getOrCompute owns the hit/miss/write/fail-open semantics (the SSoT).
    return from(
      redis.getOrCompute(key, options.ttlSeconds, () =>
        firstValueFrom(next.handle()),
      ),
    );
  }

  private buildKey(
    context: ExecutionContext,
    options: ResolvedOptions,
  ): string | null {
    const argsPayload = this.serializeArgs(context);
    let tenantSegment = '';

    if (options.scopeToTenant) {
      const tenantId = this.extractTenantId(context);
      if (!tenantId) return null;
      tenantSegment = `t:${tenantId}:`;
    }

    const argsHash = createHash('sha1')
      .update(argsPayload)
      .digest('hex')
      .slice(0, 16);

    return `farm:cache:${options.prefix}:${tenantSegment}${argsHash}`;
  }

  private extractTenantId(context: ExecutionContext): string | undefined {
    // SSoT: derive the cache-key tenant ONLY from the trusted, server-set
    // request context (req.user.tenantId from the verified JWT, or the
    // TenantGuard-validated req.tenantId) via the shared extractTenantIdSafe —
    // the SAME extractor @Tenant()/@OptionalTenant use. The raw x-tenant-id
    // header is deliberately NOT consulted: it is attacker-influenceable, and
    // keying the cache off it lets an absent/forged header diverge the cache key
    // from the tenant the handler actually executes under. When tenant context
    // is absent the key build returns null and the method runs un-cached.
    const req =
      context.getType<GqlContextType>() === 'graphql'
        ? GqlExecutionContext.create(context).getContext<{ req?: TenantRequest }>()
            .req
        : context.switchToHttp().getRequest<TenantRequest | undefined>();
    return req ? extractTenantIdSafe(req) : undefined;
  }

  /**
   * Serialize a method's args deterministically so the same call
   * always hashes to the same key. Skips the GraphQL context and
   * Request objects — they change every call and would poison the
   * key.
   */
  private serializeArgs(context: ExecutionContext): string {
    const args = context.getArgs();
    const gqlCtx =
      context.getType<GqlContextType>() === 'graphql'
        ? GqlExecutionContext.create(context)
        : null;
    if (gqlCtx) {
      // GraphQL resolver args: [root, args, context, info]. Hash
      // just the `args` object — the other three change every call.
      const gqlArgs = gqlCtx.getArgs<Record<string, unknown>>();
      return safeStringify(gqlArgs);
    }
    return safeStringify(args);
  }

}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v && typeof v === 'object' && 'headers' in (v as Record<string, unknown>)) {
        // drop request-like objects (carry volatile state)
        return undefined;
      }
      return v;
    }) ?? 'null';
  } catch {
    return 'serialize-fail';
  }
}
