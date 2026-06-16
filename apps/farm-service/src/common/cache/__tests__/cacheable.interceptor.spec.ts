/**
 * CacheableInterceptor Unit Tests
 *
 * Covers:
 *   - no @Cacheable metadata → pass through, no Redis call
 *   - metadata present + Redis has a hit → returns cached value,
 *     never calls the underlying handler
 *   - metadata present + Redis miss → calls handler, writes cache
 *     with the configured TTL
 *   - tenant-scoped method without a tenant id → bypass (no cache,
 *     handler still runs)
 *   - Redis read failure → logs + falls through to handler
 *   - Redis write failure (non-blocking) → does not swallow the
 *     underlying method's result
 *   - args hashing is stable across duplicate calls
 *
 * Uses hand-rolled Reflector / RedisService / ExecutionContext /
 * CallHandler doubles. No DI framework.
 */
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '@aquaculture/backend-common/redis';
import { lastValueFrom, of, throwError } from 'rxjs';

import {
  CACHEABLE_METADATA_KEY,
  CacheableOptions,
} from '../cacheable.decorator';
import { CacheableInterceptor } from '../cacheable.interceptor';

interface RedisDouble {
  // The interceptor now delegates the whole read-through to the single-flight
  // getOrCompute SSoT (hit/miss/write/fail-open live there + are unit-tested in
  // redis.service). These specs assert the interceptor builds the right key and
  // delegates; the single-flight semantics are NOT re-tested here.
  getOrCompute: jest.Mock;
}

interface ReflectorDouble {
  get: jest.Mock;
}

function makeExecutionContext(opts: {
  tenantId?: string;
  /**
   * Untrusted x-tenant-id header value. Set independently of `tenantId` to
   * prove the interceptor keys off the trusted req.user.tenantId, NOT the
   * header. When omitted, no x-tenant-id header is present.
   */
  headerTenantId?: string;
  contextType?: 'graphql' | 'http';
  gqlArgs?: Record<string, unknown>;
}): ExecutionContext {
  const headers: Record<string, string> = {};
  if (opts.headerTenantId) headers['x-tenant-id'] = opts.headerTenantId;
  // `tenantId` now lands on the TRUSTED source (req.user.tenantId), set by
  // JwtAuthGuard from the verified JWT — the only source the fix consults.
  const req: {
    headers: Record<string, string>;
    user?: { tenantId: string };
  } = { headers };
  if (opts.tenantId) req.user = { tenantId: opts.tenantId };
  const handler = jest.fn();
  const contextType = opts.contextType ?? 'graphql';

  const args = [null, opts.gqlArgs ?? {}, { req }, {}];
  const classRef = class FakeResolver {};

  return {
    getType: () => contextType,
    getHandler: () => handler,
    getClass: () => classRef,
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

function makeCallHandler(result: unknown): {
  handler: CallHandler;
  handle: jest.Mock;
} {
  const handle = jest.fn().mockReturnValue(of(result));
  return { handler: { handle } as CallHandler, handle };
}

function makeInterceptor(opts: {
  metadata?: CacheableOptions;
  redisGet?: unknown;
}): {
  interceptor: CacheableInterceptor;
  reflector: ReflectorDouble;
  redis: RedisDouble;
} {
  const reflector: ReflectorDouble = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === CACHEABLE_METADATA_KEY) return opts.metadata;
      return undefined;
    }),
  };
  const redis: RedisDouble = {
    // Faithful getOrCompute double: a preset redisGet is a cache HIT (returned
    // without computing); otherwise it's a MISS and we run the wrapped compute
    // (the handler), exactly like the real single-flight helper's win path.
    getOrCompute: jest
      .fn()
      .mockImplementation(
        async (
          _key: string,
          _ttl: number,
          compute: () => Promise<unknown>,
        ) => {
          if (opts.redisGet !== null && opts.redisGet !== undefined) {
            return opts.redisGet;
          }
          return compute();
        },
      ),
  };
  const interceptor = new CacheableInterceptor(
    reflector as unknown as Reflector,
    redis as unknown as RedisService,
  );
  return { interceptor, reflector, redis };
}

/** The cache key passed to getOrCompute on the Nth delegated call. */
function keyArg(redis: RedisDouble, n = 0): string {
  return redis.getOrCompute.mock.calls[n][0] as string;
}

describe('CacheableInterceptor', () => {
  it('passes through when no @Cacheable metadata is present', async () => {
    const { interceptor, redis } = makeInterceptor({ metadata: undefined });
    const ctx = makeExecutionContext({ tenantId: 't1' });
    const { handler, handle } = makeCallHandler('value');

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toBe('value');
    expect(redis.getOrCompute).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('returns the cached value without calling the handler on a hit', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: ['cachedA', 'cachedB'],
    });
    const ctx = makeExecutionContext({ tenantId: 'tenant-1' });
    const { handler, handle } = makeCallHandler(['freshA']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['cachedA', 'cachedB']);
    expect(handle).not.toHaveBeenCalled();
    expect(redis.getOrCompute).toHaveBeenCalledTimes(1);
  });

  it('delegates to getOrCompute with the configured ttl and runs the handler on a miss', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 900 },
      redisGet: null,
    });
    const ctx = makeExecutionContext({ tenantId: 'tenant-2' });
    const { handler, handle } = makeCallHandler(['fresh']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['fresh']);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(redis.getOrCompute).toHaveBeenCalledTimes(1);
    const [, ttl] = redis.getOrCompute.mock.calls[0];
    expect(ttl).toBe(900);
  });

  it('bypasses the cache (no getOrCompute) when a tenant-scoped method has no tenant id', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: ['shouldNotBeReturned'],
    });
    const ctx = makeExecutionContext({});
    const { handler, handle } = makeCallHandler(['fresh']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['fresh']);
    expect(redis.getOrCompute).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('keys off the trusted req.user.tenantId and IGNORES a divergent x-tenant-id header', async () => {
    // The discriminating test: trusted tenant A, forged header B. The cache
    // key MUST be scoped to A (the tenant the handler runs under), never B.
    // Pre-fix (header-derived) this keyed under B — a write-under-wrong-key.
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: null,
    });
    const ctx = makeExecutionContext({
      tenantId: 'trusted-A',
      headerTenantId: 'forged-B',
    });
    const { handler } = makeCallHandler(['fresh']);

    await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(keyArg(redis)).toContain('t:trusted-A:');
    expect(keyArg(redis)).not.toContain('forged-B');
  });

  it('an x-tenant-id header WITHOUT a trusted req.user.tenantId does not enable caching', async () => {
    // Header alone is not a trusted tenant source — the method must run
    // un-cached rather than key off an attacker-influenceable header.
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: ['shouldNotBeReturned'],
    });
    const ctx = makeExecutionContext({ headerTenantId: 'header-only' });
    const { handler, handle } = makeCallHandler(['fresh']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['fresh']);
    expect(redis.getOrCompute).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('propagates the underlying handler error through getOrCompute', async () => {
    // getOrCompute runs the wrapped compute (the handler) on a miss; a handler
    // error must reach the caller, not be swallowed.
    const { interceptor } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: null,
    });
    const ctx = makeExecutionContext({ tenantId: 'tenant-4' });
    const handler: CallHandler = {
      handle: () => throwError(() => new Error('underlying method failed')),
    };
    await expect(
      lastValueFrom(interceptor.intercept(ctx, handler)),
    ).rejects.toThrow('underlying method failed');
  });

  it('non-tenant-scoped cacheable uses a global key (no tenant segment needed)', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: {
        prefix: 'wq:parameterTemplates',
        ttlSeconds: 3600,
        scopeToTenant: false,
      },
      redisGet: null,
    });
    const ctx = makeExecutionContext({});
    const { handler, handle } = makeCallHandler([{ templateId: 't1' }]);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual([{ templateId: 't1' }]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(redis.getOrCompute).toHaveBeenCalledTimes(1);
    expect(keyArg(redis)).toContain('farm:cache:wq:parameterTemplates:');
    expect(keyArg(redis)).not.toMatch(/t:[^:]+:/); // no tenant segment
  });

  it('args hash is stable — two identical calls produce the same key', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: null,
    });
    const ctx1 = makeExecutionContext({
      tenantId: 'tenant-5',
      gqlArgs: { filter: { active: true } },
    });
    const ctx2 = makeExecutionContext({
      tenantId: 'tenant-5',
      gqlArgs: { filter: { active: true } },
    });
    const h1 = makeCallHandler('A');
    const h2 = makeCallHandler('B');

    await lastValueFrom(interceptor.intercept(ctx1, h1.handler));
    await lastValueFrom(interceptor.intercept(ctx2, h2.handler));
    expect(redis.getOrCompute).toHaveBeenCalledTimes(2);
    expect(keyArg(redis, 0)).toBe(keyArg(redis, 1));
  });

  it('different args produce different keys', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: null,
    });
    const ctx1 = makeExecutionContext({
      tenantId: 'tenant-6',
      gqlArgs: { filter: { active: true } },
    });
    const ctx2 = makeExecutionContext({
      tenantId: 'tenant-6',
      gqlArgs: { filter: { active: false } },
    });
    const h1 = makeCallHandler('A');
    const h2 = makeCallHandler('B');

    await lastValueFrom(interceptor.intercept(ctx1, h1.handler));
    await lastValueFrom(interceptor.intercept(ctx2, h2.handler));
    expect(keyArg(redis, 0)).not.toBe(keyArg(redis, 1));
  });
});
