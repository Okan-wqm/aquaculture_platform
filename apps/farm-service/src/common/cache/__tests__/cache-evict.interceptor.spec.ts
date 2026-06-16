/**
 * CacheEvictInterceptor Unit Tests
 *
 * Covers:
 *   - no @CacheEvict metadata → pass through
 *   - metadata present + mutation succeeds → deletePattern called
 *     with `farm:cache:<prefix>:t:<tenantId>:*` per prefix
 *   - metadata present + mutation throws → no deletePattern called
 *   - tenant-scoped + missing tenantId → skip eviction, pass through
 *   - scopeToTenant:false → deletePattern called without tenant segment
 *   - Redis deletePattern error → log + swallow; mutation result
 *     still flows
 */
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlContextType } from '@nestjs/graphql';
import { RedisService } from '@aquaculture/backend-common/redis';
import { firstValueFrom, lastValueFrom, of, throwError } from 'rxjs';

import {
  CACHE_EVICT_METADATA_KEY,
  CacheEvictOptions,
} from '../cache-evict.decorator';
import { CacheEvictInterceptor } from '../cache-evict.interceptor';

interface RedisDouble {
  deletePattern: jest.Mock;
}

function makeCtx(opts: {
  tenantId?: string;
  /** Untrusted x-tenant-id header — set independently to prove it is ignored. */
  headerTenantId?: string;
  type?: 'graphql' | 'http';
}): ExecutionContext {
  const headers: Record<string, string> = {};
  if (opts.headerTenantId) headers['x-tenant-id'] = opts.headerTenantId;
  // `tenantId` lands on the TRUSTED source (req.user.tenantId), the only
  // source the eviction scoping consults.
  const req: { headers: Record<string, string>; user?: { tenantId: string } } = {
    headers,
  };
  if (opts.tenantId) req.user = { tenantId: opts.tenantId };
  const type = opts.type ?? 'graphql';
  const classRef = class FakeResolver {};
  const args = [null, {}, { req }, {}];
  const handler = jest.fn();

  return {
    getType: () => type as GqlContextType,
    getClass: () => classRef,
    getHandler: () => handler,
    getArgs: () => args,
    getArgByIndex: (idx: number) => args[idx],
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    switchToRpc: () => ({}),
    switchToWs: () => ({}),
  } as unknown as ExecutionContext;
}

function makeInterceptor(opts: {
  metadata?: CacheEvictOptions;
  redisError?: Error;
}): { interceptor: CacheEvictInterceptor; redis: RedisDouble } {
  const reflector = {
    get: jest.fn((key: string) => {
      if (key === CACHE_EVICT_METADATA_KEY) return opts.metadata;
      return undefined;
    }),
  };
  const redis: RedisDouble = {
    deletePattern: jest.fn().mockImplementation(async (pattern: string) => {
      if (opts.redisError) throw opts.redisError;
      return pattern.length;
    }),
  };
  const interceptor = new CacheEvictInterceptor(
    reflector as unknown as Reflector,
    redis as unknown as RedisService,
  );
  return { interceptor, redis };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('CacheEvictInterceptor', () => {
  it('passes through when no @CacheEvict metadata is present', async () => {
    const { interceptor, redis } = makeInterceptor({});
    const ctx = makeCtx({ tenantId: 't1' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    const out = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(out).toEqual({ ok: true });
    expect(redis.deletePattern).not.toHaveBeenCalled();
  });

  it('evicts listed prefixes after a successful mutation (tenant-scoped)', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefixes: ['species:list', 'species:byId'] },
    });
    const ctx = makeCtx({ tenantId: 'tenant-abc' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(ctx, handler));
    await flushMicrotasks();

    expect(redis.deletePattern).toHaveBeenCalledTimes(2);
    expect(redis.deletePattern).toHaveBeenCalledWith(
      'farm:cache:species:list:t:tenant-abc:*',
    );
    expect(redis.deletePattern).toHaveBeenCalledWith(
      'farm:cache:species:byId:t:tenant-abc:*',
    );
  });

  it('scopes eviction to the trusted req.user.tenantId and IGNORES a divergent x-tenant-id header', async () => {
    // Trusted tenant A, forged header B → eviction MUST target A's segment,
    // never B's. Pre-fix (header-derived) this wiped the wrong tenant's cache.
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefixes: ['species:list'] },
    });
    const ctx = makeCtx({ tenantId: 'trusted-A', headerTenantId: 'forged-B' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(ctx, handler));
    await flushMicrotasks();

    expect(redis.deletePattern).toHaveBeenCalledTimes(1);
    expect(redis.deletePattern).toHaveBeenCalledWith(
      'farm:cache:species:list:t:trusted-A:*',
    );
  });

  it('does NOT evict when the mutation throws', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefixes: ['species:list'] },
    });
    const ctx = makeCtx({ tenantId: 'tenant-abc' });
    const handler: CallHandler = {
      handle: () => throwError(() => new Error('mutation failed')),
    };

    await expect(
      lastValueFrom(interceptor.intercept(ctx, handler)),
    ).rejects.toThrow('mutation failed');
    await flushMicrotasks();
    expect(redis.deletePattern).not.toHaveBeenCalled();
  });

  it('skips eviction when tenant-scoped but no tenant id on the call', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefixes: ['species:list'] },
    });
    const ctx = makeCtx({});
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(ctx, handler));
    await flushMicrotasks();

    expect(redis.deletePattern).not.toHaveBeenCalled();
  });

  it('scopeToTenant:false evicts across all tenants (no tenant segment)', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: {
        prefixes: ['wq:parameterTemplates'],
        scopeToTenant: false,
      },
    });
    const ctx = makeCtx({});
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(ctx, handler));
    await flushMicrotasks();

    expect(redis.deletePattern).toHaveBeenCalledTimes(1);
    expect(redis.deletePattern).toHaveBeenCalledWith(
      'farm:cache:wq:parameterTemplates:*',
    );
  });

  it('logs + swallows when Redis deletePattern fails — result still flows', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefixes: ['species:list'] },
      redisError: new Error('connection reset'),
    });
    const ctx = makeCtx({ tenantId: 'tenant-abc' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    await flushMicrotasks();

    expect(result).toEqual({ ok: true });
    expect(redis.deletePattern).toHaveBeenCalledTimes(1);
  });
});
