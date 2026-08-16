import { mockCallArgument } from '@aquaculture/testing';

import {
  buildSignedInternalHeaders,
  signedFetch,
  type SignedFetchCircuitBreakerLike,
  type SignedFetchCircuitBreakerOptionsLike,
} from '../signed-http-client';

interface ResponseBreakerArguments {
  readonly serviceName: string;
  readonly tenantId?: string;
  readonly fn: () => Promise<Response>;
  readonly options: SignedFetchCircuitBreakerOptionsLike;
  readonly fallback?: () => Response | Promise<Response>;
}

/**
 * signedFetch — pin the optional circuit-breaker integration
 * (CIRCUIT-MEDIUM-004 cure) and the back-compat raw-fetch path.
 *
 * # What this spec covers
 *
 *   - When `circuitBreaker` is supplied, the fetch executes
 *     through `circuitBreaker.service.execute()` (failures count
 *     against the per-(callee, tenant) breaker key).
 *   - When omitted, the raw fetch path runs (back-compat).
 *   - The `tenantId` propagates into the breaker's tenant key
 *     (defaulting to '*' when empty so the global per-callee
 *     bucket holds tenant-less calls).
 *
 * # Why we mock global fetch
 *
 * signedFetch calls the platform's INTERNAL_SERVICE_SECRET-bound
 * HMAC builder. We provide a test secret; the actual HMAC value
 * doesn't matter for breaker-integration tests — what matters
 * is whether fetch is wrapped or raw.
 */
describe('signedFetch — circuit-breaker integration (CIRCUIT-MEDIUM-004)', () => {
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock<Promise<Response>, [input: RequestInfo | URL, init?: RequestInit]>;

  const TEST_SECRET = 'test-secret-for-hmac-binding';

  beforeAll(() => {
    process.env['INTERNAL_SERVICE_SECRET'] = TEST_SECRET;
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    fetchMock = jest
      .fn<Promise<Response>, [input: RequestInfo | URL, init?: RequestInit]>()
      .mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    global.fetch = fetchMock;
  });

  const minimalBreakerOptions: SignedFetchCircuitBreakerOptionsLike = {
    failureMode: 'fail-closed',
    failureThreshold: 5,
    successThreshold: 3,
    volumeThreshold: 10,
    failureRatePct: 50,
    slowCallMs: 5_000,
    slowCallRatePct: 50,
    halfOpenRequests: 1,
    openTimeoutMs: 30_000,
    windowSeconds: 60,
    bucketSeconds: 10,
  };

  it('back-compat: omitting circuitBreaker runs the raw fetch path', async () => {
    await signedFetch('https://internal.example/health', {
      method: 'GET',
      serviceName: 'caller-service',
      tenantId: '',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://internal.example/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('routes the fetch through circuitBreaker.service.execute() when supplied', async () => {
    const breakerExecute = jest.fn<Promise<Response>, [args: ResponseBreakerArguments]>((args) =>
      args.fn(),
    );
    const breakerSvc: SignedFetchCircuitBreakerLike = {
      execute: breakerExecute as unknown as SignedFetchCircuitBreakerLike['execute'],
    };

    await signedFetch('https://internal.example/api', {
      method: 'POST',
      serviceName: 'caller-service',
      tenantId: '11111111-1111-4111-8111-111111111111',
      body: '{"x":1}',
      circuitBreaker: { service: breakerSvc, serviceName: 'callee-api' },
      circuitBreakerOptions: minimalBreakerOptions,
    });

    // Breaker.execute fired exactly once with the canonical args.
    expect(breakerExecute).toHaveBeenCalledTimes(1);
    const call = mockCallArgument<ResponseBreakerArguments>(breakerExecute);
    expect(call.serviceName).toBe('callee-api');
    expect(call.tenantId).toBe('11111111-1111-4111-8111-111111111111');
    expect(call.options).toBe(minimalBreakerOptions);
    // The wrapped fn must call fetch under the hood — passthrough
    // mock executes it inline.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('empty tenantId routes to the global (*) per-callee breaker bucket', async () => {
    const breakerExecute = jest.fn<Promise<Response>, [args: ResponseBreakerArguments]>((args) =>
      args.fn(),
    );
    const breakerSvc: SignedFetchCircuitBreakerLike = {
      execute: breakerExecute as unknown as SignedFetchCircuitBreakerLike['execute'],
    };

    await signedFetch('https://internal.example/health', {
      method: 'GET',
      serviceName: 'caller-service',
      tenantId: '',
      circuitBreaker: { service: breakerSvc, serviceName: 'callee-api-health' },
      circuitBreakerOptions: minimalBreakerOptions,
    });

    expect(mockCallArgument<ResponseBreakerArguments>(breakerExecute).tenantId).toBe('*');
  });

  it('surfaces breaker-side errors to the caller (fail-closed throw)', async () => {
    const breakerSvc: SignedFetchCircuitBreakerLike = {
      execute: jest.fn().mockRejectedValue(
        Object.assign(new Error('Circuit breaker is OPEN'), {
          name: 'CircuitOpenError',
        }),
      ),
    };

    await expect(
      signedFetch('https://internal.example/api', {
        method: 'GET',
        serviceName: 'caller-service',
        tenantId: 't-1',
        circuitBreaker: { service: breakerSvc, serviceName: 'callee-api' },
        circuitBreakerOptions: minimalBreakerOptions,
      }),
    ).rejects.toThrow('Circuit breaker is OPEN');

    // The raw fetch was never invoked when the breaker rejected.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips the circuitBreaker / circuitBreakerOptions fields before passing to the underlying fetch', async () => {
    const breakerSvc: SignedFetchCircuitBreakerLike = {
      execute: jest.fn<Promise<Response>, [args: ResponseBreakerArguments]>((args) =>
        args.fn(),
      ) as unknown as SignedFetchCircuitBreakerLike['execute'],
    };

    await signedFetch('https://internal.example/api', {
      method: 'POST',
      serviceName: 'caller-service',
      tenantId: 't-1',
      body: 'payload',
      circuitBreaker: { service: breakerSvc, serviceName: 'callee-api' },
      circuitBreakerOptions: minimalBreakerOptions,
    });

    const fetchInit = mockCallArgument<
      RequestInit & {
        circuitBreaker?: unknown;
        circuitBreakerOptions?: unknown;
      }
    >(fetchMock, 0, 1);
    expect(fetchInit).not.toHaveProperty('circuitBreaker');
    expect(fetchInit).not.toHaveProperty('circuitBreakerOptions');
    expect(fetchInit).not.toHaveProperty('serviceName');
    expect(fetchInit).not.toHaveProperty('tenantId');
  });
});

describe('buildSignedInternalHeaders — production keyring signing', () => {
  const savedEnv = { ...process.env };
  const productionKeyring = JSON.stringify({
    keys: [
      { kid: 'kid-1', secret: 'secret-one', status: 'active' },
      { kid: 'kid-2', secret: 'secret-two', status: 'active' },
    ],
  });

  beforeEach(() => {
    process.env = {
      ...savedEnv,
      NODE_ENV: 'production',
      SERVICE_IDENTITY_KEYRING: productionKeyring,
      SERVICE_IDENTITY_SIGNING_KID: 'kid-2',
    };
  });

  afterAll(() => {
    process.env = { ...savedEnv };
  });

  it('rejects explicit secret overrides in production', () => {
    expect(() =>
      buildSignedInternalHeaders({
        serviceName: 'gateway-api',
        tenantId: 'tenant-1',
        method: 'POST',
        path: '/graphql',
        body: '{"query":"{__typename}"}',
        secret: 'override-secret',
      }),
    ).toThrow(/secret overrides are forbidden in production/i);
  });

  it('selects SERVICE_IDENTITY_SIGNING_KID from the keyring', () => {
    const headers = buildSignedInternalHeaders({
      serviceName: 'gateway-api',
      tenantId: 'tenant-1',
      method: 'POST',
      path: '/graphql',
      body: '{"query":"{__typename}"}',
      audience: 'farm',
      nonce: 'nonce-1',
    });

    expect(headers['X-Service-Sig-Version']).toBe('v2');
    expect(headers['X-Service-Key-Id']).toBe('kid-2');
    expect(headers['X-Service-Audience']).toBe('farm');
    expect(headers['X-Service-Nonce']).toBe('nonce-1');
  });
});
