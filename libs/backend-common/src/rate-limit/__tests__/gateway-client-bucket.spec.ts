import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import express from 'express';
import { GraphQLError } from 'graphql';
import request from 'supertest';

import { buildSignedInternalHeaders } from '../../http/signed-http-client';
import { StripInternalHeadersMiddleware } from '../../middleware/strip-internal-headers.middleware';
import type { TenantRequest } from '../../types/tenant-request.interface';
import { InMemoryRateLimitStore } from '../in-memory-rate-limit.store';
import { RateLimitGuard } from '../rate-limit.guard';
import { RateLimitRouteConfig } from '../rate-limit.types';

/**
 * SEC-HIGH-202: per-client rate-limit buckets behind the gateway.
 *
 * WHY a real HTTP hop: in production every pre-auth auth mutation reaches
 * auth-service from ONE socket peer, the aqua-gateway container, so
 * `request.ip` is the same for every user. The client's own address arrives
 * only as the gateway-minted `x-client-ip` header on a v2-signed request.
 * This spec runs that hop for real: supertest is the gateway's socket, the
 * request carries a genuine v2 signature, StripInternalHeadersMiddleware
 * decides whether the header survives, and RateLimitGuard picks the bucket.
 * Every request below shares one socket peer (127.0.0.1), exactly as every
 * production refresh shares 172.20.0.30.
 */

const KEY_ID = 'gw-test-2026-10';
const KEY_SECRET = 'gateway-client-bucket-spec-secret-0123456789abcdef';
const AUDIENCE = 'auth-service';
const REFRESH: RateLimitRouteConfig = { name: 'refresh', limit: 1, windowMs: 60_000 };
const BODY = JSON.stringify({
  query:
    'mutation Refresh($input: RefreshTokenInput!) { refreshToken(input: $input) { accessToken } }',
  variables: { input: { refreshToken: '' } },
});

const noopHandler = (): void => undefined;

interface Hop {
  /** Service identity that signs the hop; undefined = unsigned (direct reach). */
  signer?: 'gateway-api' | 'billing-service';
  /** Signing key; a wrong secret models a forged signature. */
  secret?: string;
  /** Value of the x-client-ip header the caller sends, if any. */
  clientIp?: string;
}

function hopHeaders(hop: Hop): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (hop.signer) {
    // The exact builder the gateway's AuthenticatedDataSource uses at its
    // fetch boundary, so the signature covers these body bytes.
    Object.assign(
      headers,
      buildSignedInternalHeaders({
        serviceName: hop.signer,
        tenantId: '',
        method: 'POST',
        path: '/graphql',
        query: '',
        contentType: 'application/json',
        audience: AUDIENCE,
        body: BODY,
        secret: hop.secret ?? KEY_SECRET,
        keyId: KEY_ID,
      }),
    );
  }
  if (hop.clientIp) {
    headers['x-client-ip'] = hop.clientIp;
  }
  return headers;
}

function graphqlContext(req: TenantRequest): ExecutionContext {
  // Apollo's resolver tuple [root, args, ctx, info]; auth-service's GraphQL
  // context is `{ req, res }` built from the same Express request.
  const host = new ExecutionContextHost(
    [undefined, {}, { req }, { parentType: { name: 'Mutation' }, fieldName: 'refreshToken' }],
    null,
    noopHandler,
  );
  host.setType('graphql');
  return host;
}

function buildSubgraph(store: InMemoryRateLimitStore): express.Express {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(REFRESH);
  const guard = new RateLimitGuard(reflector, store);
  const strip = new StripInternalHeadersMiddleware(
    new ConfigService({
      SERVICE_IDENTITY_KEYRING: JSON.stringify([
        { kid: KEY_ID, secret: KEY_SECRET, status: 'active' },
      ]),
      SERVICE_IDENTITY_AUDIENCE: AUDIENCE,
    }),
  );

  const app = express();
  app.use(express.text({ type: 'application/json' }));
  // auth-service mounts StripInternalHeadersMiddleware first (app.module.ts).
  app.use((req, res, next) => strip.use(req, res, next));
  app.post('/graphql', (req: TenantRequest, res) => {
    // verifiedAs reports which service identity the middleware verified, so
    // each case proves the trust branch it claims to exercise.
    const verifiedAs = req.verifiedIdentity?.serviceName ?? null;
    guard.canActivate(graphqlContext(req)).then(
      () => {
        res.status(200).json({ verifiedAs });
      },
      (error: unknown) => {
        // A GraphQL operation over its limit is a coded GraphQLError, not an
        // HttpException (which a GraphQL client would see as INTERNAL_SERVER_ERROR).
        const rateLimited =
          error instanceof GraphQLError && error.extensions['code'] === 'TOO_MANY_REQUESTS';
        res
          .status(rateLimited ? 429 : error instanceof HttpException ? error.getStatus() : 500)
          .json({ verifiedAs });
      },
    );
  });
  return app;
}

interface HopResult {
  status: number;
  verifiedAs: string | null;
}

async function send(app: express.Express, hop: Hop): Promise<HopResult> {
  const response = await request(app).post('/graphql').set(hopHeaders(hop)).send(BODY);
  const body = response.body as { verifiedAs: string | null };
  return { status: response.status, verifiedAs: body.verifiedAs };
}

async function refresh(app: express.Express, hop: Hop): Promise<number> {
  return (await send(app, hop)).status;
}

describe('RateLimitGuard client buckets behind the gateway (SEC-HIGH-202)', () => {
  let store: InMemoryRateLimitStore;
  let keys: string[];
  let app: express.Express;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
    keys = [];
    const increment = store.incrementOrCreate.bind(store);
    jest.spyOn(store, 'incrementOrCreate').mockImplementation(async (key, windowMs) => {
      keys.push(key);
      return increment(key, windowMs);
    });
    app = buildSubgraph(store);
  });

  afterEach(() => {
    store.destroy();
    jest.restoreAllMocks();
  });

  it('gives two clients behind the same gateway socket separate refresh buckets', async () => {
    const alice = { signer: 'gateway-api', clientIp: '198.51.100.10' } as const;
    const bob = { signer: 'gateway-api', clientIp: '203.0.113.20' } as const;

    expect(await send(app, alice)).toEqual({ status: 200, verifiedAs: 'gateway-api' });
    // Alice spent her window; Bob, on the same gateway socket, did not.
    expect(await refresh(app, alice)).toBe(429);
    expect(await refresh(app, bob)).toBe(200);

    expect(keys).toEqual([
      'refresh:ip:198.51.100.10',
      'refresh:ip:198.51.100.10',
      'refresh:ip:203.0.113.20',
    ]);
  });

  it('strips a client-supplied x-client-ip from an unsigned request, so it cannot pick a bucket', async () => {
    // An attacker on the internal network plants the victim's address and
    // rotates it. The header is stripped; every call counts against the
    // attacker's own socket bucket.
    expect(await send(app, { clientIp: '198.51.100.10' })).toEqual({
      status: 200,
      verifiedAs: null,
    });
    expect(await refresh(app, { clientIp: '198.51.100.11' })).toBe(429);

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toContain('198.51.100.');

    // The victim's own bucket was never touched.
    expect(await refresh(app, { signer: 'gateway-api', clientIp: '198.51.100.10' })).toBe(200);
  });

  it('strips x-client-ip when the gateway signature is forged', async () => {
    const forged: Hop = {
      signer: 'gateway-api',
      secret: 'not-the-gateway-key-0123456789abcdef0123',
      clientIp: '198.51.100.10',
    };

    expect(await send(app, forged)).toEqual({ status: 200, verifiedAs: null });
    expect(keys[0]).not.toContain('198.51.100.10');
  });

  it('ignores x-client-ip from a verified caller that is not the gateway', async () => {
    expect(await send(app, { signer: 'billing-service', clientIp: '198.51.100.10' })).toEqual({
      status: 200,
      verifiedAs: 'billing-service',
    });
    expect(keys[0]).not.toContain('198.51.100.10');
  });

  it('keeps a gateway hop without a client IP in the shared socket bucket, never unlimited', async () => {
    expect(await send(app, { signer: 'gateway-api' })).toEqual({
      status: 200,
      verifiedAs: 'gateway-api',
    });
    expect(await refresh(app, { signer: 'gateway-api' })).toBe(429);
    expect(new Set(keys).size).toBe(1);
  });
});
