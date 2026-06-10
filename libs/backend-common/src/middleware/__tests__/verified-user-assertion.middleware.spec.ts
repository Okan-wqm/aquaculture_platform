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

    const error = next.mock.calls[0]?.[0] as unknown as Error;
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('Verified user assertion is required');
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

    const error = next.mock.calls[0]?.[0] as unknown as Error;
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('tenant does not match');
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

    const error = next.mock.calls[0]?.[0] as unknown as Error;
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('expired');
  });

  it('rejects assertions that were not attached to a verified service request', () => {
    const req = createRequest({
      headers: { 'x-verified-user-assertion': encodeAssertion() },
      verifiedIdentity: undefined,
    });

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0] as unknown as Error;
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('requires service identity');
  });
});
