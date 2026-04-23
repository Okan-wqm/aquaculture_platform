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
import { RedisService } from '@aquaculture/backend-common';
import { createHash } from 'crypto';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';

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

    // Read-through: look up, return hit, else execute + write.
    return from(this.readCache(key)).pipe(
      switchMap((cached) => {
        if (cached !== null && cached !== undefined) {
          return of(cached);
        }
        return next.handle().pipe(
          tap((result) => {
            this.writeCache(key, result, options.ttlSeconds).catch(
              (err: unknown) => {
                this.logger.warn(
                  `Cache write failed for ${key}: ${(err as Error).message}`,
                );
              },
            );
          }),
        );
      }),
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
    if (context.getType<GqlContextType>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const ctx = gqlCtx.getContext<{
        req?: { headers?: Record<string, string | string[] | undefined> };
      }>();
      const header = ctx?.req?.headers?.['x-tenant-id'];
      if (typeof header === 'string' && header.length > 0) return header;
      return undefined;
    }
    const req = context.switchToHttp().getRequest<
      { headers?: Record<string, string | string[] | undefined> } | undefined
    >();
    const header = req?.headers?.['x-tenant-id'];
    return typeof header === 'string' && header.length > 0 ? header : undefined;
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

  private async readCache(key: string): Promise<unknown> {
    if (!this.redisService) return null;
    try {
      return await this.redisService.getJson(key);
    } catch (err) {
      this.logger.warn(
        `Cache read failed for ${key}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async writeCache(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    if (!this.redisService) return;
    await this.redisService.setJson(key, value, ttlSeconds);
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
