import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import {
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  impersonationAuthorizationRequestDigestV1,
} from '@aquaculture/shared-contracts';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ImpersonationAuthorizationService,
  type ImpersonationAuthorizationBaseRequest,
} from './impersonation-authorization.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const CREDENTIAL = 'a'.repeat(64);
const QUERY_HASH = 'b'.repeat(64);
const BODY_HASH = 'c'.repeat(64);

const BASE_REQUEST: ImpersonationAuthorizationBaseRequest = Object.freeze({
  credential: CREDENTIAL,
  authorization: 'Bearer admin-access',
  verifiedUserAssertion: 'signed-gateway-user-assertion',
  authorizationReceiptId: RECEIPT_ID,
  sessionId: SESSION_ID,
  actorId: ADMIN_ID,
  mfaVerified: true,
  targetTenantId: TENANT_ID,
  method: 'POST',
  normalizedPath: '/graphql',
  normalizedQueryHash: QUERY_HASH,
  bodyHash: BODY_HASH,
  clientIp: '203.0.113.4',
  clientUserAgent: 'browser-test',
});

function authorityResponse(
  extraData: Readonly<Record<string, unknown>> = {},
  contextOverrides: Readonly<Record<string, unknown>> = {},
): Response {
  return new Response(
    JSON.stringify({
      data: {
        ...extraData,
        context: {
          sessionId: SESSION_ID,
          superAdminId: ADMIN_ID,
          targetTenantId: TENANT_ID,
          permissions: {
            canViewData: true,
            canModifyData: false,
            canAccessSettings: false,
            canManageUsers: false,
            canViewBilling: false,
            canExportData: false,
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          isActive: true,
          ...contextOverrides,
        },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function expectedRequestDigest(): string {
  return impersonationAuthorizationRequestDigestV1({
    schemaVersion: IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
    authorizationReceiptId: RECEIPT_ID,
    sessionId: SESSION_ID,
    actorId: ADMIN_ID,
    mfaVerified: true,
    effectiveTenantId: TENANT_ID,
    method: 'POST',
    normalizedPath: '/graphql',
    normalizedQueryHash: QUERY_HASH,
    bodyHash: BODY_HASH,
    clientIp: '203.0.113.4',
    clientUserAgent: 'browser-test',
  });
}

describe('ImpersonationAuthorizationService', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let breakerExecute: jest.Mock;
  let service: ImpersonationAuthorizationService;
  const originalSigningSecret = process.env['SERVICE_IDENTITY_SIGNING_SECRET'];
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['SERVICE_IDENTITY_SIGNING_SECRET'] = 'test-impersonation-signing-secret';
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    globalThis.fetch = fetchMock;
    breakerExecute = jest.fn(
      async ({ fn }: { readonly fn: () => Promise<unknown> }): Promise<unknown> => fn(),
    );
    const breaker = Object.create(CircuitBreakerService.prototype) as CircuitBreakerService;
    Object.defineProperty(breaker, 'execute', { value: breakerExecute });
    service = new ImpersonationAuthorizationService(
      new ConfigService({ ADMIN_API_INTERNAL_URL: 'http://admin-api-service:3008/graphql' }),
      breaker,
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalSigningSecret === undefined) {
      delete process.env['SERVICE_IDENTITY_SIGNING_SECRET'];
    } else {
      process.env['SERVICE_IDENTITY_SIGNING_SECRET'] = originalSigningSecret;
    }
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('rejects malformed coordinates before network or breaker work', async () => {
    await expect(
      service.resolveContext({ ...BASE_REQUEST, credential: 'invalid' }),
    ).resolves.toBeNull();
    expect(breakerExecute).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs read-only context resolution through signed gateway authority', async () => {
    fetchMock.mockResolvedValueOnce(authorityResponse());

    await expect(service.resolveContext(BASE_REQUEST)).resolves.toMatchObject({
      sessionId: SESSION_ID,
      superAdminId: ADMIN_ID,
      targetTenantId: TENANT_ID,
      permissions: { canViewData: true, canModifyData: false },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://admin-api-service:3008/api/impersonation/sessions/authorization-context',
    );
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(BASE_REQUEST.authorization);
    expect(headers['x-impersonation-token']).toBe(CREDENTIAL);
    expect(headers['X-Verified-User-Assertion']).toBe(BASE_REQUEST.verifiedUserAssertion);
    expect(headers['X-Service-Audience']).toBe('admin-api-service');
    const body = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
    expect(body).toMatchObject({
      schemaVersion: IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
      authorizationReceiptId: RECEIPT_ID,
      sessionId: SESSION_ID,
      effectiveTenantId: TENANT_ID,
      requestDigest: expectedRequestDigest(),
    });
    expect(body).not.toHaveProperty('actorId');
    expect(body).not.toHaveProperty('mfaVerified');
    expect(body).not.toHaveProperty('clientIp');
    expect(body).not.toHaveProperty('clientUserAgent');
    expect(JSON.stringify(body)).not.toContain(CREDENTIAL);
  });

  it('commits and strictly verifies an exact operation receipt', async () => {
    fetchMock.mockResolvedValueOnce(
      authorityResponse({
        authorizationReceiptId: RECEIPT_ID,
        requestDigest: expectedRequestDigest(),
        replayed: false,
      }),
    );
    const operations = [
      { authority: 'data.read', module: 'farm', operation: 'Query.farms' },
    ] as const;

    await expect(service.authorizeOperations(BASE_REQUEST, operations)).resolves.toMatchObject({
      authorizationReceiptId: RECEIPT_ID,
      requestDigest: expectedRequestDigest(),
      replayed: false,
      sessionId: SESSION_ID,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://admin-api-service:3008/api/impersonation/sessions/authorization-receipts',
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({ operations });
  });

  it('maps signed authority denial to null without a fallback authority', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(service.resolveContext(BASE_REQUEST)).resolves.toBeNull();
  });

  it('rejects expired, structurally incomplete, or mismatched receipt payloads', async () => {
    fetchMock.mockResolvedValueOnce(
      authorityResponse({}, { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    await expect(service.resolveContext(BASE_REQUEST)).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(
      authorityResponse({
        authorizationReceiptId: RECEIPT_ID,
        requestDigest: 'f'.repeat(64),
        replayed: false,
      }),
    );
    await expect(
      service.authorizeOperations(BASE_REQUEST, [
        { authority: 'data.read', module: 'farm', operation: 'Query.farms' },
      ]),
    ).resolves.toBeNull();
  });

  it('fails closed through the circuit breaker on authority errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(service.resolveContext(BASE_REQUEST)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(breakerExecute).toHaveBeenCalledTimes(1);
  });
});
