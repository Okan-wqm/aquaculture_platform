import type { SignedFetchCircuitBreakerLike } from '../../http/signed-http-client';
import type { FeatureEvaluationSnapshotTransport } from '../fail-closed-feature-toggle.client';
import {
  createSignedFeatureEvaluationTransport,
  FEATURE_EVALUATION_RESPONSE_MAX_BYTES,
  type SignedFeatureEvaluationTransportOptions,
} from '../signed-feature-evaluation.transport';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const KEYRING = JSON.stringify([{ kid: 'active', secret: 'a'.repeat(32), status: 'active' }]);

describe('createSignedFeatureEvaluationTransport', () => {
  const originalKeyring = process.env['SERVICE_IDENTITY_KEYRING'];
  const originalKid = process.env['SERVICE_IDENTITY_SIGNING_KID'];

  beforeEach(() => {
    process.env['SERVICE_IDENTITY_KEYRING'] = KEYRING;
    process.env['SERVICE_IDENTITY_SIGNING_KID'] = 'active';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv('SERVICE_IDENTITY_KEYRING', originalKeyring);
    restoreEnv('SERVICE_IDENTITY_SIGNING_KID', originalKid);
  });

  it('calls the admin authority with tenant-bound HMAC-v2 headers', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ signed: true }));
    const transport = createTransport();

    await expect(
      transport({ tenantId: TENANT_ID, featureKeys: ['marine_explorer'] }, identity),
    ).resolves.toEqual({ signed: true });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(url).toBe('http://admin-api-service:3000/api/v1/internal/feature-toggles/evaluate');
    expect(headers.get('x-service-identity')).toBe('gateway-api');
    expect(headers.get('x-service-audience')).toBe('admin-api-service');
    expect(headers.get('x-tenant-id')).toBe(TENANT_ID);
    expect(init?.body).toBe(JSON.stringify({ featureKeys: ['marine_explorer'] }));
    expect(init?.redirect).toBe('error');
  });

  it('rejects a fail-open breaker policy before opening the authority connection', () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    expect(() =>
      createSignedFeatureEvaluationTransport({
        ...transportOptions(),
        circuitBreakerOptions: {
          ...transportOptions().circuitBreakerOptions,
          failureMode: 'fail-open-degraded',
        },
      }),
    ).toThrow('requires a fail-closed circuit breaker');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-2xx, non-JSON, and oversized responses', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const transport = createTransport();

    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(
      transport({ tenantId: TENANT_ID, featureKeys: ['marine_explorer'] }, identity),
    ).rejects.toThrow('authority rejected');

    fetchSpy.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    await expect(
      transport({ tenantId: TENANT_ID, featureKeys: ['marine_explorer'] }, identity),
    ).rejects.toThrow('not JSON');

    fetchSpy.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(FEATURE_EVALUATION_RESPONSE_MAX_BYTES + 1),
        },
      }),
    );
    await expect(
      transport({ tenantId: TENANT_ID, featureKeys: ['marine_explorer'] }, identity),
    ).rejects.toThrow('byte limit');
  });

  it('counts response authentication failures inside the circuit breaker', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse({ signed: false }));
    const observedFailures: unknown[] = [];
    let executions = 0;
    const breaker: SignedFetchCircuitBreakerLike = {
      execute: async (args) => {
        executions += 1;
        try {
          return await args.fn();
        } catch (error) {
          observedFailures.push(error);
          throw error;
        }
      },
    };
    const transport = createTransport(breaker);

    await expect(
      transport({ tenantId: TENANT_ID, featureKeys: ['marine_explorer'] }, () => {
        throw new Error('snapshot signature is invalid');
      }),
    ).rejects.toThrow('snapshot signature is invalid');

    expect(executions).toBe(1);
    expect(observedFailures).toHaveLength(1);
  });

  it('cancels a rejected response body before failing closed', async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(stream, { status: 503 }));
    const transport = createTransport();

    await expect(
      transport({ tenantId: TENANT_ID, featureKeys: ['marine_explorer'] }, identity),
    ).rejects.toThrow('authority rejected');

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

function createTransport(
  breaker?: SignedFetchCircuitBreakerLike,
): FeatureEvaluationSnapshotTransport {
  return createSignedFeatureEvaluationTransport(transportOptions(breaker));
}

function transportOptions(
  breaker?: SignedFetchCircuitBreakerLike,
): SignedFeatureEvaluationTransportOptions {
  const resolvedBreaker: SignedFetchCircuitBreakerLike = breaker ?? {
    execute: async (args) => args.fn(),
  };
  return {
    adminBaseUrl: 'http://admin-api-service:3000',
    serviceName: 'gateway-api' as const,
    timeoutMs: 1_000,
    circuitBreaker: { service: resolvedBreaker, serviceName: 'admin-feature-evaluation' },
    circuitBreakerOptions: {
      failureMode: 'fail-closed' as const,
      failureThreshold: 5,
      successThreshold: 3,
      volumeThreshold: 10,
      failureRatePct: 50,
      slowCallMs: 500,
      slowCallRatePct: 50,
      halfOpenRequests: 3,
      openTimeoutMs: 30_000,
      windowSeconds: 10,
      bucketSeconds: 1,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function identity(value: unknown): unknown {
  return value;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}
