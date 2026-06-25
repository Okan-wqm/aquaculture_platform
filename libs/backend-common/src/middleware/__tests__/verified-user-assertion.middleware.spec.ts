import { BadRequestException } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import type { TenantRequest } from '../../types/tenant-request.interface';
import { VerifiedUserAssertionMiddleware } from '../verified-user-assertion.middleware';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EFFECTIVE_TENANT = '22222222-2222-4222-8222-222222222222';

function encodeAssertion(overrides: Record<string, unknown> = {}): string {
  const assertion = {
    issuer: 'gateway-api',
    subject: 'user-1',
    tenantId: TENANT,
    effectiveTenantId: EFFECTIVE_TENANT,
    roles: ['FARM_MANAGER'],
    email: 'user@example.com',
    mfaVerified: true,
    issuedAt: new Date().toISOString(),
    assertionId: 'assertion-1',
    ...overrides,
  };

  return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url');
}

function createRequest(overrides: Partial<TenantRequest> = {}): TenantRequest {
  return {
    headers: {},
    method: 'GET',
    originalUrl: '/batches',
    url: '/batches',
    verifiedIdentity: {
      serviceName: 'gateway-api',
      tenantId: EFFECTIVE_TENANT,
      effectiveTenantId: EFFECTIVE_TENANT,
      keyId: 'gateway-2026-05',
      nonce: 'nonce-1',
      version: 'v2',
    },
    ...overrides,
  } as TenantRequest;
}

describe('VerifiedUserAssertionMiddleware', () => {
  let middleware: VerifiedUserAssertionMiddleware;
  let next: jest.MockedFunction<NextFunction>;
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    middleware = new VerifiedUserAssertionMiddleware();
    next = jest.fn();
    process.env['NODE_ENV'] = 'production';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('parses gateway assertions and strips legacy raw identity headers', () => {
    const req = createRequest({
      headers: {
        'x-verified-user-assertion': encodeAssertion(),
        'x-user-id': 'spoofed-user',
        'x-user-roles': '["SUPER_ADMIN"]',
        'x-user-payload': '{"sub":"spoofed-user"}',
        'x-act-as-tenant': TENANT,
      },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.verifiedUserAssertion).toEqual(
      expect.objectContaining({
        issuer: 'gateway-api',
        subject: 'user-1',
        effectiveTenantId: EFFECTIVE_TENANT,
      }),
    );
    expect(req.user).toEqual(
      expect.objectContaining({
        sub: 'user-1',
        tenantId: EFFECTIVE_TENANT,
        roles: ['FARM_MANAGER'],
        mfaVerified: true,
      }),
    );
    expect(req.headers['x-user-id']).toBeUndefined();
    expect(req.headers['x-user-roles']).toBeUndefined();
    expect(req.headers['x-user-payload']).toBeUndefined();
    expect(req.headers['x-act-as-tenant']).toBeUndefined();
  });

  it('fails closed for production gateway requests without a verified assertion', () => {
    const req = createRequest();

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', expect.stringContaining('Verified user assertion is required'));
  });

  it('does not require user assertions on probe paths', () => {
    const req = createRequest({ originalUrl: '/health/ready', url: '/health/ready' });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('does not require user assertions for signed GraphQL introspection', () => {
    const req = createRequest({
      method: 'POST',
      originalUrl: '/graphql',
      url: '/graphql',
      body: { operationName: 'IntrospectionQuery', query: '{ __schema { queryType { name } } }' },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('does not require user assertions from non-gateway internal callers', () => {
    const req = createRequest({
      verifiedIdentity: {
        serviceName: 'sensor-service',
        tenantId: TENANT,
        effectiveTenantId: TENANT,
        keyId: 'sensor-2026-05',
        nonce: 'nonce-3',
        version: 'v2',
      },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });


  it('rejects assertions whose effective tenant differs from the signed service tenant', () => {
    const req = createRequest({
      verifiedIdentity: {
        serviceName: 'gateway-api',
        tenantId: TENANT,
        effectiveTenantId: TENANT,
        keyId: 'gateway-2026-05',
        nonce: 'nonce-2',
        version: 'v2',
      },
      headers: { 'x-verified-user-assertion': encodeAssertion() },
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', expect.stringContaining('tenant does not match'));
  });

  it('rejects stale assertions', () => {
    const req = createRequest({
      headers: {
        'x-verified-user-assertion': encodeAssertion({
          issuedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
        }),
      },
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', expect.stringContaining('expired'));
  });

  it('rejects assertions that were not attached to a verified service request', () => {
    const req = createRequest({
      headers: { 'x-verified-user-assertion': encodeAssertion() },
      verifiedIdentity: undefined,
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', expect.stringContaining('requires service identity'));
  });

  // SEC-HIGH-051 / SEC-HIGH-052: the object-level authorization claims must
  // round-trip through build → parse → req.user, and a malformed claim must be
  // rejected fail-closed.
  it('round-trips assignedSiteIds + mobileFeatures onto req.user', () => {
    const req = createRequest({
      headers: {
        'x-verified-user-assertion': encodeAssertion({
          assignedSiteIds: ['site-a', 'site-b'],
          mobileFeatures: ['mortality', 'harvest'],
        }),
      },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual(
      expect.objectContaining({
        assignedSiteIds: ['site-a', 'site-b'],
        mobileFeatures: ['mortality', 'harvest'],
      }),
    );
    expect(req.verifiedUserAssertion?.assignedSiteIds).toEqual(['site-a', 'site-b']);
    expect(req.verifiedUserAssertion?.mobileFeatures).toEqual(['mortality', 'harvest']);
  });

  it('omits the claims on req.user when the assertion does not carry them', () => {
    const req = createRequest({
      headers: { 'x-verified-user-assertion': encodeAssertion() },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user?.assignedSiteIds).toBeUndefined();
    expect(req.user?.mobileFeatures).toBeUndefined();
  });

  // SSOT-C-13: the plan tier ordinal threads through the same build → parse →
  // req.user path so resource-create handlers can enforce per-plan quotas.
  it('round-trips planLevel onto req.user', () => {
    const req = createRequest({
      headers: { 'x-verified-user-assertion': encodeAssertion({ planLevel: 2 }) },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user?.planLevel).toBe(2);
    expect(req.verifiedUserAssertion?.planLevel).toBe(2);
  });

  it('omits planLevel on req.user when the assertion does not carry it', () => {
    const req = createRequest({
      headers: { 'x-verified-user-assertion': encodeAssertion() },
    });

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user?.planLevel).toBeUndefined();
  });

  it('rejects a malformed planLevel claim (non-number, fail-closed)', () => {
    const req = createRequest({
      headers: {
        'x-verified-user-assertion': encodeAssertion({ planLevel: 'pro' }),
      },
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('rejects a malformed assignedSiteIds claim (non-string member, fail-closed)', () => {
    const req = createRequest({
      headers: {
        'x-verified-user-assertion': encodeAssertion({ assignedSiteIds: ['site-a', 42] }),
      },
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', expect.stringContaining('invalid assignedSiteIds'));
  });

  it('rejects a malformed mobileFeatures claim (non-array, fail-closed)', () => {
    const req = createRequest({
      headers: {
        'x-verified-user-assertion': encodeAssertion({ mobileFeatures: 'mortality' }),
      },
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', expect.stringContaining('invalid mobileFeatures'));
  });
});
