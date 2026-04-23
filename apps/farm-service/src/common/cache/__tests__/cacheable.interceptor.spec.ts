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
import { RedisService } from '@aquaculture/backend-common';
import { lastValueFrom, of, throwError } from 'rxjs';

import {
  CACHEABLE_METADATA_KEY,
  CacheableOptions,
} from '../cacheable.decorator';
import { CacheableInterceptor } from '../cacheable.interceptor';

interface RedisDouble {
  getJson: jest.Mock;
  setJson: jest.Mock;
}

interface ReflectorDouble {
  get: jest.Mock;
}

function makeExecutionContext(opts: {
  tenantId?: string;
  contextType?: 'graphql' | 'http';
  gqlArgs?: Record<string, unknown>;
}): ExecutionContext {
  const headers: Record<string, string> = {};
  if (opts.tenantId) headers['x-tenant-id'] = opts.tenantId;
  const req = { headers };
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
  redisGetError?: Error;
  redisSetError?: Error;
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
    getJson: jest
      .fn()
      .mockImplementation(async () => {
        if (opts.redisGetError) throw opts.redisGetError;
        return opts.redisGet ?? null;
      }),
    setJson: jest
      .fn()
      .mockImplementation(async () => {
        if (opts.redisSetError) throw opts.redisSetError;
      }),
  };
  const interceptor = new CacheableInterceptor(
    reflector as unknown as Reflector,
    redis as unknown as RedisService,
  );
  return { interceptor, reflector, redis };
}

describe('CacheableInterceptor', () => {
  it('passes through when no @Cacheable metadata is present', async () => {
    const { interceptor, redis } = makeInterceptor({ metadata: undefined });
    const ctx = makeExecutionContext({ tenantId: 't1' });
    const { handler, handle } = makeCallHandler('value');

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toBe('value');
    expect(redis.getJson).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
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
    expect(redis.getJson).toHaveBeenCalledTimes(1);
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('calls the handler and writes the cache on a miss', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 900 },
      redisGet: null,
    });
    const ctx = makeExecutionContext({ tenantId: 'tenant-2' });
    const { handler, handle } = makeCallHandler(['fresh']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['fresh']);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledTimes(1);
    const [, value, ttl] = redis.setJson.mock.calls[0];
    expect(value).toEqual(['fresh']);
    expect(ttl).toBe(900);
  });

  it('bypasses cache when a tenant-scoped method is called without tenant id', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: ['shouldNotBeReturned'],
    });
    const ctx = makeExecutionContext({});
    const { handler, handle } = makeCallHandler(['fresh']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['fresh']);
    expect(redis.getJson).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('falls through to the handler when Redis read fails', async () => {
    const { interceptor, redis } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGetError: new Error('connection refused'),
    });
    const ctx = makeExecutionContext({ tenantId: 'tenant-3' });
    const { handler, handle } = makeCallHandler(['fresh']);

    const result = await lastValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toEqual(['fresh']);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledTimes(1);
  });

  it('does not swallow the underlying error when Redis write fails', async () => {
    // Redis write is best-effort — the interceptor logs and the
    // result still flows through. A downstream error from the
    // method should still reach the caller.
    const { interceptor } = makeInterceptor({
      metadata: { prefix: 'species:list', ttlSeconds: 60 },
      redisGet: null,
      redisSetError: new Error('write fail'),
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
    expect(redis.setJson).toHaveBeenCalledTimes(1);
    const [key] = redis.setJson.mock.calls[0];
    expect(key).toContain('farm:cache:wq:parameterTemplates:');
    expect(key).not.toMatch(/t:[^:]+:/); // no tenant segment
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
    expect(redis.setJson).toHaveBeenCalledTimes(2);
    expect(redis.setJson.mock.calls[0][0]).toBe(
      redis.setJson.mock.calls[1][0],
    );
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
    expect(redis.setJson.mock.calls[0][0]).not.toBe(
      redis.setJson.mock.calls[1][0],
    );
  });
});
