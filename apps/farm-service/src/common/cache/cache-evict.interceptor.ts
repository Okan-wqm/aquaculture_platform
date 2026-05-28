/**
 * CacheEvictInterceptor
 *
 * Reads @CacheEvict metadata and issues Redis `deletePattern`
 * against every listed prefix AFTER the handler's observable
 * completes successfully. Failures do not block the mutation —
 * the original value still propagates and the TTL eventually
 * expires any stale entry the deletePattern missed.
 *
 * Phase 7.3.2 of the "Farm modülü kalan kör noktalar" plan.
 */
import { RedisService } from '@aquaculture/backend-common/redis';
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
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { CACHE_EVICT_METADATA_KEY, CacheEvictOptions } from './cache-evict.decorator';

interface ResolvedOptions extends CacheEvictOptions {
  scopeToTenant: boolean;
}

@Injectable()
export class CacheEvictInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheEvictInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const handler = context.getHandler();
    const metadata = this.reflector.get<CacheEvictOptions | undefined>(
      CACHE_EVICT_METADATA_KEY,
      handler,
    );
    if (!metadata || !this.redisService) {
      return next.handle();
    }
    const options: ResolvedOptions = {
      scopeToTenant: true,
      ...metadata,
    };

    return next.handle().pipe(
      tap({
        next: () => {
          // Fire-and-forget — the caller already got the mutation
          // result before the eviction kicks in. Cache-delete
          // latency should not appear in the mutation's response
          // path. Errors are logged but do not propagate.
          void this.evict(context, options).catch((err: unknown) => {
            this.logger.warn(
              `Cache eviction failed for prefixes [${options.prefixes.join(', ')}]: ` +
                `${(err as Error).message}`,
            );
          });
        },
        // On error we deliberately DO NOTHING. A failed mutation
        // must not wipe the cache — the data never changed.
      }),
    );
  }

  private async evict(context: ExecutionContext, options: ResolvedOptions): Promise<void> {
    if (!this.redisService) return;

    let tenantSegment = '';
    if (options.scopeToTenant) {
      const tenantId = this.extractTenantId(context);
      if (!tenantId) {
        this.logger.warn(
          `CacheEvict: tenant-scoped mutation fired without a tenant id; ` +
            `skipping eviction for [${options.prefixes.join(', ')}] so we do ` +
            `not wipe other tenants' entries.`,
        );
        return;
      }
      tenantSegment = `t:${tenantId}:`;
    }

    for (const prefix of options.prefixes) {
      const pattern = `farm:cache:${prefix}:${tenantSegment}*`;
      const count = await this.redisService.deletePattern(pattern);
      this.logger.debug(`CacheEvict: pattern='${pattern}' removed=${count}`);
    }
  }

  private extractTenantId(context: ExecutionContext): string | undefined {
    if (context.getType<GqlContextType>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const ctx = gqlCtx.getContext<{ req?: TenantScopedRequest }>();
      return resolveRequestTenant(ctx?.req);
    }
    const req = context.switchToHttp().getRequest<TenantScopedRequest | undefined>();
    return resolveRequestTenant(req);
  }
}

interface TenantScopedRequest {
  tenantId?: string;
  user?: { tenantId?: string | null };
}

function resolveRequestTenant(req: TenantScopedRequest | undefined): string | undefined {
  const tenantId = req?.tenantId ?? req?.user?.tenantId ?? undefined;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined;
}
