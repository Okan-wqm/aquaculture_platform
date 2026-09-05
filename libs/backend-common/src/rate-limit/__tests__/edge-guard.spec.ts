import {
  ExecutionContext,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { GraphQLError } from 'graphql';

import { RateLimitGuard } from '../rate-limit.guard';
import { RateLimitEdgeConfig, RateLimitRouteConfig, RateLimitStore } from '../rate-limit.types';

const noopHandler = (): void => undefined;

const EDGE: RateLimitEdgeConfig = {
  tiers: {
    default: { name: 'default', limit: 3, windowMs: 60_000 },
    anonymous: { name: 'anonymous', limit: 2, windowMs: 60_000 },
    tenant: { name: 'tenant', limit: 5, windowMs: 60_000 },
    login: { name: 'login', limit: 1, windowMs: 60_000 },
    marineRender: { name: 'marine-render', limit: 1, windowMs: 60_000 },
    mutations: { name: 'mutations', limit: 2, windowMs: 60_000 },
  },
  endpointBuckets: [
    { tier: 'login', paths: ['/auth/login'], graphqlMutations: ['login'] },
    {
      tier: 'marineRender',
      paths: [],
      pathTemplates: ['/api/marine/sites/:siteId/render'],
    },
  ],
  mutationTier: 'mutations',
};

interface EdgeRequest {
  ip?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  user?: { sub?: string; tenantId?: string };
  res: { setHeader: jest.Mock };
}

function httpContext(opts: { ip?: string; url?: string; user?: EdgeRequest['user'] }): {
  context: ExecutionContext;
  setHeader: jest.Mock;
} {
  const setHeader = jest.fn();
  const request: EdgeRequest = {
    ip: opts.ip ?? '203.0.113.50',
    url: opts.url,
    headers: {},
    user: opts.user,
    res: { setHeader },
  };
  const host = new ExecutionContextHost([request, request.res], null, noopHandler);
  host.setType('http');
  return { context: host, setHeader };
}

function gqlContext(opts: {
  ip?: string;
  user?: EdgeRequest['user'];
  parentType?: string;
  fieldName?: string;
}): ExecutionContext {
  const request: EdgeRequest = {
    ip: opts.ip ?? '203.0.113.51',
    headers: {},
    user: opts.user,
    res: { setHeader: jest.fn() },
  };
  const info = opts.parentType
    ? { parentType: { name: opts.parentType }, fieldName: opts.fieldName }
    : undefined;
  const host = new ExecutionContextHost([undefined, {}, { req: request }, info], null, noopHandler);
  host.setType('graphql');
  return host;
}

function edgeGuard(
  opts: { decorator?: RateLimitRouteConfig; store?: RateLimitStore } = {},
): RateLimitGuard {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(opts.decorator);
  return new RateLimitGuard(reflector, opts.store, EDGE);
}

describe('RateLimitGuard — edge mode', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the GraphQL field name so the `login` mutation is bounded by the login tier (SEC-HIGH-061)', async () => {
    const guard = edgeGuard();
    // login tier = 1 (stricter than anonymous = 2 and mutations = 2): the second
    // login attempt from one IP is refused by the login rule, not the identity one.
    const ctx = (): ExecutionContext =>
      gqlContext({ ip: '198.51.100.70', parentType: 'Mutation', fieldName: 'login' });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('a mutation the login bucket does not list keeps the identity tier (anonymous = 2)', async () => {
    const guard = edgeGuard();
    const ctx = (): ExecutionContext =>
      gqlContext({ ip: '198.51.100.71', parentType: 'Mutation', fieldName: 'createBatch' });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('limits a non-decorated anonymous request by the anonymous tier (2/window)', async () => {
    const guard = edgeGuard();
    const { context, setHeader } = httpContext({ ip: '198.51.100.40', url: '/graphql' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);

    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '2');
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('applies the login tier to the exact /auth/login path (1/window)', async () => {
    const guard = edgeGuard();
    const ctx = (): ExecutionContext =>
      httpContext({ ip: '198.51.100.41', url: '/auth/login' }).context;

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('does NOT apply the login tier to a suffix-attack path (falls to anonymous 2/window)', async () => {
    const guard = edgeGuard();
    const ctx = (): ExecutionContext =>
      httpContext({ ip: '198.51.100.42', url: '/auth/login/foo' }).context;

    // anonymous tier = 2, so the 2nd still passes (login tier would have blocked it).
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('limits costly dynamic marine renders per verified user', async () => {
    const guard = edgeGuard();
    const context = (userId: string): ExecutionContext =>
      httpContext({
        ip: '198.51.100.99',
        url: '/api/marine/sites/site-1/render',
        user: { sub: userId, tenantId: 'tenant-1' },
      }).context;

    await expect(guard.canActivate(context('user-1'))).resolves.toBe(true);
    await expect(guard.canActivate(context('user-1'))).rejects.toThrow(HttpException);
    await expect(guard.canActivate(context('user-2'))).resolves.toBe(true);
  });

  it('decorator config WINS over edge config when both are present', async () => {
    // Decorator name 'deco' limit 1 must apply (edge default would be 3).
    const guard = edgeGuard({ decorator: { name: 'deco', limit: 1, windowMs: 60_000 } });
    const ctx = (): ExecutionContext =>
      httpContext({ ip: '198.51.100.43', url: '/graphql', user: { sub: 'u1' } }).context;

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('bounds a GraphQL mutation ADDITIVELY — anonymous tier (stricter) bites first as HttpException', async () => {
    const guard = edgeGuard();
    const ctx = (): ExecutionContext => gqlContext({ ip: '198.51.100.44', parentType: 'Mutation' });

    // anonymous tier = 2; the primary tier (HttpException) bounds before the
    // mutation cap would, proving the identity tier is NOT bypassed for mutations.
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(HttpException);
  });

  it('throws GraphQLError when the mutation cap bites under a loose identity tier', async () => {
    const guard = edgeGuard();
    // Authenticated tenant → tenant tier (5, loose); mutations cap = 2 bites first.
    const ctx = (): ExecutionContext =>
      gqlContext({
        ip: '198.51.100.45',
        user: { sub: 'u9', tenantId: 't9' },
        parentType: 'Mutation',
      });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    await expect(guard.canActivate(ctx())).rejects.toThrow(GraphQLError);
    try {
      await guard.canActivate(ctx());
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions['code']).toBe('TOO_MANY_REQUESTS');
      expect((error as GraphQLError).extensions['retryAfter']).toBeGreaterThanOrEqual(1);
    }
  });

  it('does NOT add the mutation cap to a GraphQL query', async () => {
    const guard = edgeGuard();
    // Authenticated tenant query → tenant tier 5; 3 queries all pass (mutation cap 2 not applied).
    const ctx = (): ExecutionContext =>
      gqlContext({ ip: '198.51.100.46', user: { sub: 'u8', tenantId: 't8' }, parentType: 'Query' });

    for (let i = 0; i < 3; i++) {
      await expect(guard.canActivate(ctx())).resolves.toBe(true);
    }
  });

  it('counts a GraphQL mutation through TWO distinct keys (identity + mutation), proving additive separation', async () => {
    const keys: string[] = [];
    const counts = new Map<string, number>();
    const recording: RateLimitStore = {
      incrementOrCreate: (key, windowMs) => {
        keys.push(key);
        const c = (counts.get(key) ?? 0) + 1;
        counts.set(key, c);
        return Promise.resolve({
          entry: { count: c, resetTime: 4_102_444_800_000 + windowMs },
          isNew: c === 1,
        });
      },
      isHealthy: () => true,
      clear: () => Promise.resolve(),
      destroy: () => undefined,
    };
    const guard = edgeGuard({ store: recording });
    // Anonymous GraphQL mutation → primary 'anonymous' tier + additive 'mutations' tier.
    await guard.canActivate(gqlContext({ ip: '198.51.100.60', parentType: 'Mutation' }));

    expect(keys).toEqual(['anonymous:ip:198.51.100.60', 'mutations:ip:198.51.100.60']);
    // Distinct tier prefixes → no cross-talk between the identity and mutation budgets.
    expect(new Set(keys).size).toBe(2);
  });

  it('mutation-tier reject sets ONLY the primary tier headers, never the mutation limit', async () => {
    const setHeader = jest.fn();
    const request = {
      ip: '198.51.100.61',
      headers: {},
      user: { sub: 'u7', tenantId: 't7' }, // tenant tier (5, loose) is primary; mutations (2) bites
      res: { setHeader },
    };
    const ctx = (): ExecutionContext => {
      const host = new ExecutionContextHost(
        [undefined, {}, { req: request }, { parentType: { name: 'Mutation' } }],
        null,
        noopHandler,
      );
      host.setType('graphql');
      return host;
    };
    const guard = edgeGuard();

    await guard.canActivate(ctx());
    await guard.canActivate(ctx());
    await expect(guard.canActivate(ctx())).rejects.toThrow(GraphQLError);

    // X-RateLimit-Limit reflects the PRIMARY tier (tenant=5), never the mutation cap (2).
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
    expect(setHeader).not.toHaveBeenCalledWith('X-RateLimit-Limit', '2');
    // The GraphQLError mutation reject carries retryAfter in extensions, not an HTTP Retry-After header.
    expect(setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
  });

  it('logs an unverified-X-Forwarded-For warning in production (operator trust-proxy signal)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const previousEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const guard = edgeGuard(); // constructed under production → isProduction=true
      const request = {
        ip: '127.0.0.1', // loopback → falls through to X-Forwarded-For
        url: '/graphql',
        headers: { 'x-forwarded-for': '8.8.8.8' },
        res: { setHeader: jest.fn() },
      };
      const host = new ExecutionContextHost([request, request.res], null, noopHandler);
      host.setType('http');

      await guard.canActivate(host);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('X-Forwarded-For'));
    } finally {
      process.env['NODE_ENV'] = previousEnv;
      warnSpy.mockRestore();
    }
  });

  it('fails CLOSED in production when the distributed store is down (edge path)', async () => {
    const failingStore: RateLimitStore = {
      incrementOrCreate: jest.fn().mockRejectedValue(new Error('redis down')),
      isHealthy: () => false,
      clear: jest.fn(),
      destroy: jest.fn(),
    };
    const previousEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const guard = edgeGuard({ store: failingStore });
      await expect(guard.canActivate(httpContext({ url: '/graphql' }).context)).rejects.toThrow(
        ServiceUnavailableException,
      );
    } finally {
      process.env['NODE_ENV'] = previousEnv;
    }
  });
});
