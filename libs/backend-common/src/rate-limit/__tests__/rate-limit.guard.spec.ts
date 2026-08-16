import { ExecutionContext, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { InMemoryRateLimitStore } from '../in-memory-rate-limit.store';
import { RateLimitEnforcementService } from '../rate-limit-enforcement.service';
import { RateLimitGuard } from '../rate-limit.guard';
import { RateLimitRouteConfig, RateLimitStore } from '../rate-limit.types';

interface MockRequest {
  ip?: string;
  user?: { sub?: string; tenantId?: string };
  body?: Record<string, unknown>;
  res: { setHeader: jest.Mock };
}

const noopHandler = (): void => undefined;

// Build a REAL NestJS ExecutionContext: ExecutionContextHost is the exact class
// the framework instantiates, so the guard's GqlExecutionContext.create() and
// switchToHttp() paths behave identically to production — no hand-rolled mock
// and no cast (the banned-construct gate forbids the double-cast-through-unknown
// shortcut even in specs). HTTP args = [request, response]; GQL args = Apollo's
// [root, args, ctx, info] tuple that GqlExecutionContext reads positionally.
const buildContext = (type: 'http' | 'graphql', args: unknown[]): ExecutionContext => {
  const host = new ExecutionContextHost(args, null, noopHandler);
  host.setType(type);
  return host;
};

describe('RateLimitGuard', () => {
  const enforcementServices: RateLimitEnforcementService[] = [];
  const buildHttpContext = (
    options: {
      ip?: string;
      user?: { sub?: string; tenantId?: string };
      body?: Record<string, unknown>;
    } = {},
  ): { context: ExecutionContext; setHeader: jest.Mock } => {
    const setHeader = jest.fn();
    const request: MockRequest = {
      ip: options.ip ?? '203.0.113.1',
      user: options.user,
      body: options.body,
      res: { setHeader },
    };
    return { context: buildContext('http', [request, request.res]), setHeader };
  };

  const buildGqlContext = (
    options: {
      ip?: string;
      args?: Record<string, unknown>;
      user?: { sub?: string };
    } = {},
  ): ExecutionContext => {
    const request: MockRequest = {
      ip: options.ip ?? '203.0.113.2',
      user: options.user,
      res: { setHeader: jest.fn() },
    };
    // WHAT: GqlExecutionContext.create reads getArgs/getContext positions —
    // [root, args, ctx, info] mirrors Apollo's resolver signature.
    return buildContext('graphql', [undefined, options.args ?? {}, { req: request }, undefined]);
  };

  const guardWith = (
    config: RateLimitRouteConfig | undefined,
    store?: RateLimitStore,
  ): RateLimitGuard => {
    // Real Reflector instance + a typed spy — no cast. The guard only reads
    // getAllAndOverride; spying returns the per-test route config.
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(config);
    const enforcement = new RateLimitEnforcementService(new ConfigService(), store);
    enforcementServices.push(enforcement);
    return new RateLimitGuard(reflector, enforcement);
  };

  afterEach(() => {
    jest.restoreAllMocks();
    enforcementServices.splice(0).forEach((service) => service.onModuleDestroy());
  });

  it('allows handlers without @RateLimit metadata (explicit-config mode)', async () => {
    const guard = guardWith(undefined);
    const { context } = buildHttpContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('enforces the window and rejects with 429 + Retry-After header', async () => {
    const guard = guardWith({ name: 'login', limit: 3, windowMs: 60_000 });
    const { context, setHeader } = buildHttpContext({ ip: '198.51.100.7' });

    for (let i = 0; i < 3; i++) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    try {
      await guard.canActivate(context);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      const body = (error as HttpException).getResponse() as { retryAfter: number };
      expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    }
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '3');
  });

  it('keys buckets per IP — a second IP has its own window', async () => {
    const guard = guardWith({ name: 'login', limit: 1, windowMs: 60_000 });

    await expect(
      guard.canActivate(buildHttpContext({ ip: '198.51.100.10' }).context),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(buildHttpContext({ ip: '198.51.100.10' }).context),
    ).rejects.toThrow(HttpException);

    // Different IP — fresh window
    await expect(
      guard.canActivate(buildHttpContext({ ip: '198.51.100.11' }).context),
    ).resolves.toBe(true);
  });

  it('prefers the custom identifier dimension (per-account budget across IPs)', async () => {
    const guard = guardWith({
      name: 'login',
      limit: 1,
      windowMs: 60_000,
      identifier: ({ args }) =>
        ((args?.['input'] as { email?: string } | undefined)?.email ?? '').toLowerCase() ||
        undefined,
    });

    // Same account from two DIFFERENT IPs shares one window — IP rotation
    // does not buy a distributed attacker fresh budget for one account.
    await expect(
      guard.canActivate(
        buildGqlContext({ ip: '198.51.100.20', args: { input: { email: 'A@x.com' } } }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        buildGqlContext({ ip: '198.51.100.21', args: { input: { email: 'a@x.com' } } }),
      ),
    ).rejects.toThrow(HttpException);
  });

  it('keys authenticated callers per user id', async () => {
    const guard = guardWith({ name: 'refresh', limit: 1, windowMs: 60_000 });

    await expect(
      guard.canActivate(buildHttpContext({ ip: '1.1.1.1', user: { sub: 'u1' } }).context),
    ).resolves.toBe(true);
    // Same user from a DIFFERENT IP — same bucket
    await expect(
      guard.canActivate(buildHttpContext({ ip: '2.2.2.2', user: { sub: 'u1' } }).context),
    ).rejects.toThrow(HttpException);
    // Different user — fresh bucket
    await expect(
      guard.canActivate(buildHttpContext({ ip: '1.1.1.1', user: { sub: 'u2' } }).context),
    ).resolves.toBe(true);
  });

  it('fails CLOSED in production when the distributed store is down', async () => {
    const failingStore: RateLimitStore = {
      incrementOrCreate: jest.fn().mockRejectedValue(new Error('redis down')),
      isHealthy: () => false,
      clear: jest.fn(),
      destroy: jest.fn(),
    };
    const previousEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const guard = guardWith({ name: 'login', limit: 5, windowMs: 60_000 }, failingStore);
      await expect(guard.canActivate(buildHttpContext().context)).rejects.toThrow(
        ServiceUnavailableException,
      );
    } finally {
      process.env['NODE_ENV'] = previousEnv;
    }
  });

  it('degrades to the in-process fallback outside production (logged, not silent)', async () => {
    const failingStore: RateLimitStore = {
      incrementOrCreate: jest.fn().mockRejectedValue(new Error('redis down')),
      isHealthy: () => false,
      clear: jest.fn(),
      destroy: jest.fn(),
    };
    const guard = guardWith({ name: 'login', limit: 1, windowMs: 60_000 }, failingStore);
    const { context } = buildHttpContext({ ip: '198.51.100.30' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Fallback still ENFORCES the window — degradation is not a bypass.
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
  });

  it('fails CLOSED outside production when the route requires distributed state', async () => {
    const guard = guardWith({
      name: 'failed-auth',
      limit: 5,
      windowMs: 60_000,
      requiresDistributedStore: true,
    });

    await expect(guard.canActivate(buildHttpContext().context)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('expires windows over time (in-memory store)', async () => {
    jest.useFakeTimers();
    try {
      const store = new InMemoryRateLimitStore();
      const first = await store.incrementOrCreate('k', 1_000);
      expect(first.entry.count).toBe(1);
      const second = await store.incrementOrCreate('k', 1_000);
      expect(second.entry.count).toBe(2);

      jest.advanceTimersByTime(1_001);

      const afterReset = await store.incrementOrCreate('k', 1_000);
      expect(afterReset.entry.count).toBe(1);
      expect(afterReset.isNew).toBe(true);
      store.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
