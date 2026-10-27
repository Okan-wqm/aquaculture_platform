import { decideAccess, userCaller } from '@aquaculture/shared-contracts';
import { BadRequestException } from '@nestjs/common';
import type { NextFunction, Response } from 'express';

import { buildGatewayVerifiedUserAssertion } from '../../http/gateway-verified-user-assertion';
import type { JwtUser, TenantRequest } from '../../types/tenant-request.interface';
import { VerifiedUserAssertionMiddleware } from '../verified-user-assertion.middleware';

const TENANT = '11111111-1111-4111-8111-111111111111';

function encodeAssertion(overrides: Record<string, unknown> = {}): string {
  const assertion = {
    issuer: 'gateway-api',
    subject: 'user-1',
    tenantId: TENANT,
    effectiveTenantId: TENANT,
    roles: ['MODULE_USER'],
    email: null,
    mfaVerified: false,
    issuedAt: new Date().toISOString(),
    assertionId: 'assertion-1',
    ...overrides,
  };
  return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url');
}

function createRequest(assertion: string): TenantRequest {
  const request: Partial<TenantRequest> = {
    headers: { 'x-verified-user-assertion': assertion },
    method: 'POST',
    originalUrl: '/graphql',
    url: '/graphql',
    verifiedIdentity: {
      serviceName: 'gateway-api',
      tenantId: TENANT,
      effectiveTenantId: TENANT,
      keyId: 'gateway-2026-05',
      nonce: 'nonce-1',
      version: 'v2',
    },
  };
  return request as TenantRequest;
}

function verifiedUser(req: TenantRequest): JwtUser {
  if (!req.user) throw new Error('the middleware built no verified user');
  return req.user;
}

/** The member caller PKG-05's @AccessCaller builds, from the rebuilt verified user. */
function callerOf(user: JwtUser): ReturnType<typeof userCaller> {
  return userCaller({
    userId: user.sub,
    tenantId: user.tenantId ?? null,
    roles: user.roles,
    moduleAccess: user.moduleAccess,
    capabilities: user.resourcePermissions,
  });
}

/**
 * RBAC-HIGH-028: the per-module grant reaches every subgraph. The gateway binds `moduleAccess`
 * into the HMAC-protected assertion (ADR-051 §2 Transport); the subgraph middleware validates it
 * and rebuilds it into the verified user, from which the member caller of PKG-02 is built. A
 * malformed claim is 400; an absent one (a gateway of the previous release) means no grants.
 */
describe('VerifiedUserAssertionMiddleware — moduleAccess (RBAC-HIGH-028)', () => {
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

  it('rebuilds the claim into the verified user, so the member caller holds the grant', () => {
    const req = createRequest(
      encodeAssertion({ moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_USER' } }),
    );

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.verifiedUserAssertion?.moduleAccess).toEqual({
      farm: 'MODULE_MANAGER',
      hr: 'MODULE_USER',
    });
    const caller = callerOf(verifiedUser(req));
    expect(caller.moduleAccess).toEqual({ farm: 'MODULE_MANAGER', hr: 'MODULE_USER' });
    expect(
      decideAccess(caller, {
        spec: { kind: 'module', module: 'farm' },
        intent: 'write',
        roles: ['MODULE_MANAGER'],
      }).allowed,
    ).toBe(true);
    expect(
      decideAccess(caller, {
        spec: { kind: 'module', module: 'sensor' },
        intent: 'read',
        roles: [],
      }).allowed,
    ).toBe(false);
  });

  it('reads the assertion the gateway builds, end to end', () => {
    const req = createRequest(
      buildGatewayVerifiedUserAssertion({
        subject: 'user-1',
        tenantId: TENANT,
        roles: ['MODULE_USER'],
        moduleAccess: { sensor: 'MODULE_USER' },
      }),
    );

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(verifiedUser(req).moduleAccess).toEqual({ sensor: 'MODULE_USER' });
  });

  it('reads an absent claim as no grants', () => {
    const req = createRequest(encodeAssertion());

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect('moduleAccess' in verifiedUser(req)).toBe(false);
    expect(callerOf(verifiedUser(req)).moduleAccess).toEqual({});
  });

  it('never turns the global MODULE_MANAGER role into a grant', () => {
    const req = createRequest(encodeAssertion({ roles: ['MODULE_MANAGER'], moduleAccess: {} }));

    middleware.use(req, {} as Response, next);

    const caller = callerOf(verifiedUser(req));
    expect(
      decideAccess(caller, {
        spec: { kind: 'module', module: 'hr' },
        intent: 'read',
        roles: [],
      }).allowed,
    ).toBe(false);
  });

  it.each([
    ['a module that owns no data', { alert: 'MODULE_USER' }],
    ['an unknown module', { greenhouse: 'MODULE_MANAGER' }],
    ['an account role', { farm: 'TENANT_ADMIN' }],
    ['a missing role', { farm: null }],
    ['a list of codes', ['farm']],
    ['a string', 'farm'],
    ['null', null],
  ])('answers a claim naming %s with 400', (_label, moduleAccess) => {
    const req = createRequest(encodeAssertion({ moduleAccess }));

    middleware.use(req, {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toHaveProperty('message', 'Verified user assertion has invalid moduleAccess');
    expect(req.user).toBeUndefined();
  });
});
