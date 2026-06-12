import {
  generateServiceIdentityHeaders,
  generateServiceIdentityHeadersV2,
} from '@aquaculture/backend-common/utils';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { EventStoreServiceIdentityGuard } from './event-store-service-identity.guard';

const tenantId = '123e4567-e89b-42d3-a456-426614174000';
const otherTenantId = '223e4567-e89b-42d3-a456-426614174000';

function contextForRequest(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function keyring(secret = 'test-secret'): string {
  return JSON.stringify({
    keys: [
      {
        kid: 'kid-1',
        secret,
        status: 'active',
        callers: ['farm-service'],
        audiences: ['event-store-service'],
        tenantScopePolicy: 'tenant-bound',
      },
    ],
  });
}

function signedHeaders(input: {
  body: string;
  secret?: string;
  contentType?: string;
  effectiveTenantId?: string;
  audience?: string;
  serviceName?: string;
  query?: string;
}): Record<string, string> {
  const headers = generateServiceIdentityHeadersV2({
    serviceName: input.serviceName ?? 'farm-service',
    secret: input.secret ?? 'test-secret',
    tenantId,
    method: 'POST',
    path: '/events',
    body: input.body,
    keyId: 'kid-1',
    audience: input.audience ?? 'event-store-service',
    contentType: input.contentType ?? 'application/json',
    effectiveTenantId: input.effectiveTenantId,
    query: input.query,
    nonce: 'nonce-1',
  });
  return {
    'content-type': input.contentType ?? 'application/json',
    'x-tenant-id': tenantId,
    'x-service-identity': headers['X-Service-Identity'],
    'x-service-timestamp': headers['X-Service-Timestamp'],
    'x-service-signature': headers['X-Service-Signature'],
    'x-service-sig-version': headers['X-Service-Sig-Version'],
    'x-service-method': headers['X-Service-Method'],
    'x-service-path': headers['X-Service-Path'],
    'x-service-body-hash': headers['X-Service-Body-Hash'],
    'x-service-key-id': headers['X-Service-Key-Id'] ?? '',
    'x-service-audience': headers['X-Service-Audience'] ?? '',
    'x-service-query-hash': headers['X-Service-Query-Hash'],
    'x-service-content-type': headers['X-Service-Content-Type'] ?? '',
    'x-service-assertion-hash': headers['X-Service-Assertion-Hash'],
    'x-service-nonce': headers['X-Service-Nonce'],
    'x-service-effective-tenant-id': headers['X-Service-Effective-Tenant-ID'],
  };
}

describe('EventStoreServiceIdentityGuard', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it('allows only exact health endpoints without authentication', () => {
    process.env['NODE_ENV'] = 'test';
    const guard = new EventStoreServiceIdentityGuard();

    expect(
      guard.canActivate(
        contextForRequest({
          originalUrl: '/health/ready',
          method: 'GET',
          headers: {},
        }),
      ),
    ).toBe(true);

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/health/ready/extra',
          method: 'GET',
          headers: {},
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('allows the exact Prometheus /metrics scrape path without authentication (OBS-HIGH-001)', () => {
    process.env['NODE_ENV'] = 'test';
    const guard = new EventStoreServiceIdentityGuard();

    expect(
      guard.canActivate(
        contextForRequest({
          originalUrl: '/metrics',
          method: 'GET',
          headers: {},
        }),
      ),
    ).toBe(true);

    // Prefix abuse stays rejected — only the exact scrape path is public.
    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/metrics/extra',
          method: 'GET',
          headers: {},
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects legacy internal API key', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = keyring();

    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: '',
          headers: {
            'x-internal-api-key': 'test-secret',
            'x-tenant-id': tenantId,
          },
        }),
      ),
    ).toThrow(/v2 service identity/i);
  });

  it('rejects v1 HMAC service identity', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = keyring();
    const headers = generateServiceIdentityHeaders('farm-service', 'test-secret', tenantId);
    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: '',
          rawBody: Buffer.from(''),
          headers: {
            'x-tenant-id': tenantId,
            'x-service-identity': headers['X-Service-Identity'],
            'x-service-timestamp': headers['X-Service-Timestamp'],
            'x-service-signature': headers['X-Service-Signature'],
          },
        }),
      ),
    ).toThrow(/v2 service identity/i);
  });

  it('accepts v2 keyring signatures and stores verified tenant context', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = keyring();
    const body = JSON.stringify({ event: 'created' });
    const request = {
      originalUrl: '/events',
      path: '/events',
      method: 'POST',
      body: { event: 'created' },
      rawBody: Buffer.from(body),
      headers: signedHeaders({ body }),
    } as Record<string, unknown>;

    const guard = new EventStoreServiceIdentityGuard();

    expect(guard.canActivate(contextForRequest(request))).toBe(true);
    expect(request['tenantId']).toBe(tenantId);
    expect(request['verifiedIdentity']).toMatchObject({
      serviceName: 'farm-service',
      tenantId,
      effectiveTenantId: tenantId,
      keyId: 'kid-1',
      audience: 'event-store-service',
      version: 'v2',
    });
  });

  it('verifies query hashes with the canonical leading question mark', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = keyring();
    const body = JSON.stringify({ event: 'created' });
    const request = {
      originalUrl: '/events?stream=tenant',
      path: '/events',
      method: 'POST',
      body: { event: 'created' },
      rawBody: Buffer.from(body),
      headers: signedHeaders({ body, query: '?stream=tenant' }),
    } as Record<string, unknown>;

    const guard = new EventStoreServiceIdentityGuard();

    expect(guard.canActivate(contextForRequest(request))).toBe(true);
    expect(request['tenantId']).toBe(tenantId);
  });

  it('rejects tenant-bound keys that request another effective tenant', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = keyring();
    const body = JSON.stringify({ event: 'created' });
    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: { event: 'created' },
          rawBody: Buffer.from(body),
          headers: signedHeaders({ body, effectiveTenantId: otherTenantId }),
        }),
      ),
    ).toThrow(/not allowed to access this tenant/i);
  });

  it('rejects all-tenants keys for callers that are not catalog-authorized', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = JSON.stringify({
      keys: [
        {
          kid: 'kid-1',
          secret: 'test-secret',
          status: 'active',
          callers: ['farm-service'],
          audiences: ['event-store-service'],
          tenantScopePolicy: 'all-tenants',
        },
      ],
    });
    const body = JSON.stringify({ event: 'created' });
    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: { event: 'created' },
          rawBody: Buffer.from(body),
          headers: signedHeaders({ body, effectiveTenantId: otherTenantId }),
        }),
      ),
    ).toThrow(/all-tenants scope/i);
  });

  it('accepts all-tenants keys only for catalog-authorized callers', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = JSON.stringify({
      keys: [
        {
          kid: 'kid-1',
          secret: 'test-secret',
          status: 'active',
          callers: ['admin-api-service'],
          audiences: ['event-store-service'],
          tenantScopePolicy: 'all-tenants',
        },
      ],
    });
    const body = JSON.stringify({ event: 'created' });
    const request = {
      originalUrl: '/events',
      path: '/events',
      method: 'POST',
      body: { event: 'created' },
      rawBody: Buffer.from(body),
      headers: signedHeaders({
        body,
        serviceName: 'admin-api-service',
        effectiveTenantId: otherTenantId,
      }),
    } as Record<string, unknown>;

    const guard = new EventStoreServiceIdentityGuard();

    expect(guard.canActivate(contextForRequest(request))).toBe(true);
    expect(request['tenantId']).toBe(otherTenantId);
    expect(request['verifiedIdentity']).toMatchObject({
      serviceName: 'admin-api-service',
      tenantId,
      effectiveTenantId: otherTenantId,
      keyId: 'kid-1',
      audience: 'event-store-service',
      version: 'v2',
    });
  });

  it('rejects disabled key ids', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = JSON.stringify({
      keys: [{ kid: 'kid-1', secret: 'test-secret', status: 'disabled' }],
    });
    const body = JSON.stringify({ event: 'created' });
    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: { event: 'created' },
          rawBody: Buffer.from(body),
          headers: signedHeaders({ body }),
        }),
      ),
    ).toThrow(/v2 service identity/i);
  });

  it('rejects v2 HMAC when content type is tampered', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = keyring();
    const body = JSON.stringify({ event: 'created' });
    const headers = signedHeaders({ body, contentType: 'application/json' });
    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: { event: 'created' },
          rawBody: Buffer.from(body),
          headers: {
            ...headers,
            'content-type': 'text/plain',
          },
        }),
      ),
    ).toThrow(/v2 service identity/i);
  });

  it('rejects caller-selected audiences even when the key allows them', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SERVICE_IDENTITY_KEYRING'] = JSON.stringify({
      keys: [
        {
          kid: 'kid-1',
          secret: 'test-secret',
          status: 'active',
          callers: ['farm-service'],
          audiences: ['event-store-service', 'billing-service'],
        },
      ],
    });
    const body = JSON.stringify({ event: 'created' });
    const guard = new EventStoreServiceIdentityGuard();

    expect(() =>
      guard.canActivate(
        contextForRequest({
          originalUrl: '/events',
          path: '/events',
          method: 'POST',
          body: { event: 'created' },
          rawBody: Buffer.from(body),
          headers: signedHeaders({ body, audience: 'billing-service' }),
        }),
      ),
    ).toThrow(/v2 service identity/i);
  });
});
