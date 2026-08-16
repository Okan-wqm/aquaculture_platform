import { ForbiddenException } from '@nestjs/common';
import { TenantStatus } from '@platform/event-contracts';
import { getRequestContext, requestContextStorage } from '@aquaculture/backend-common/logging';
import type { Response } from 'express';

import { JwtPayload } from '../guards/auth.guard';
import { ImpersonationAuthorizationService } from '../services/impersonation-authorization.service';
import {
  expectImpersonationOperationDispatch,
  impersonationReceiptLedgerSnapshot,
} from '../security/impersonation-receipt-completion';

import {
  CaptureRequestedTenantMiddleware,
  EffectiveTenantMiddleware,
  RequestWithEffectiveTenant,
} from './effective-tenant.middleware';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const IMPERSONATION_CREDENTIAL = 'a'.repeat(64);

type MockUser = Partial<JwtPayload> & { mfaVerified?: boolean };

function mockReq(
  over: {
    headers?: Record<string, string>;
    user?: MockUser;
    requestedActAsTenant?: string;
    requestedImpersonationToken?: string;
    requestedImpersonationSessionId?: string;
    authorizationReceiptId?: string;
    method?: string;
    path?: string;
    originalUrl?: string;
    ip?: string;
    body?: unknown;
  } = {},
): RequestWithEffectiveTenant {
  return {
    headers: {},
    method: 'GET',
    path: '/graphql',
    originalUrl: '/graphql',
    url: '/graphql',
    ...over,
  } as RequestWithEffectiveTenant;
}
const res = {} as Response;

// A SUPER_ADMIN platform account omits tenantId (null at runtime) — undefined
// here exercises the same `?? null`/`?? undefined` paths in the middleware.
const SUPER_ADMIN: MockUser = {
  sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  roles: ['SUPER_ADMIN'],
  mfaVerified: true,
};

function superAdminActAs(
  targetTenantId: string,
  over: Parameters<typeof mockReq>[0] = {},
): RequestWithEffectiveTenant {
  return mockReq({
    user: SUPER_ADMIN,
    requestedActAsTenant: targetTenantId,
    requestedImpersonationToken: IMPERSONATION_CREDENTIAL,
    requestedImpersonationSessionId: SESSION_ID,
    authorizationReceiptId: RECEIPT_ID,
    method: 'POST',
    originalUrl: '/graphql',
    path: '/graphql',
    ip: '203.0.113.5',
    body: { query: 'query Farms { farms { id } }' },
    headers: {
      authorization: 'Bearer platform-admin-token',
      'content-type': 'application/json',
      'user-agent': 'effective-tenant-test/1.0',
    },
    ...over,
  });
}

describe('CaptureRequestedTenantMiddleware', () => {
  const mw = new CaptureRequestedTenantMiddleware();

  it('captures x-act-as-tenant (highest precedence)', () => {
    const req = mockReq({ headers: { 'x-act-as-tenant': TENANT_A, 'x-tenant-id': TENANT_B } });
    const next = jest.fn();
    mw.use(req, res, next);
    expect(req.requestedActAsTenant).toBe(TENANT_A);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to x-tenant-id when no x-act-as-tenant', () => {
    const req = mockReq({ headers: { 'x-tenant-id': TENANT_B } });
    mw.use(req, res, jest.fn());
    expect(req.requestedActAsTenant).toBe(TENANT_B);
  });

  it('captures nothing when neither header present', () => {
    const req = mockReq();
    const next = jest.fn();
    mw.use(req, res, next);
    expect(req.requestedActAsTenant).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('captures canonical hand-off coordinates and mints a distinct receipt UUID', () => {
    const first = mockReq({
      headers: {
        'x-impersonation-token': IMPERSONATION_CREDENTIAL,
        'x-impersonation-session-id': SESSION_ID,
      },
    });
    const second = mockReq();
    mw.use(first, res, jest.fn());
    mw.use(second, res, jest.fn());
    expect(first.requestedImpersonationToken).toBe(IMPERSONATION_CREDENTIAL);
    expect(first.requestedImpersonationSessionId).toBe(SESSION_ID);
    expect(first.authorizationReceiptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second.authorizationReceiptId).not.toBe(first.authorizationReceiptId);
  });
});

describe('EffectiveTenantMiddleware', () => {
  let lookup: { lookupTenant: jest.Mock };
  let impersonationAuthorization: {
    resolveContext: jest.Mock;
    authorizeOperations: jest.Mock;
  };
  let mw: EffectiveTenantMiddleware;
  const originalMfaRequirement = process.env['MFA_REQUIRED_FOR_CROSS_TENANT'];

  beforeEach(() => {
    delete process.env['MFA_REQUIRED_FOR_CROSS_TENANT'];
    lookup = { lookupTenant: jest.fn().mockResolvedValue({ status: TenantStatus.ACTIVE }) };
    impersonationAuthorization = {
      resolveContext: jest.fn().mockImplementation(({ targetTenantId }: { targetTenantId: string }) =>
        Promise.resolve({
          sessionId: SESSION_ID,
          superAdminId: SUPER_ADMIN.sub,
          targetTenantId,
          permissions: {
            canViewData: true,
            canModifyData: true,
            canAccessSettings: true,
            canManageUsers: true,
            canViewBilling: true,
            canExportData: true,
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
      authorizeOperations: jest.fn().mockImplementation(
        ({ targetTenantId }: { targetTenantId: string }) =>
          Promise.resolve({
            authorizationReceiptId: RECEIPT_ID,
            requestDigest: 'd'.repeat(64),
            replayed: false,
            sessionId: SESSION_ID,
            superAdminId: SUPER_ADMIN.sub,
            targetTenantId,
            permissions: {
              canViewData: true,
              canModifyData: true,
              canAccessSettings: true,
              canManageUsers: true,
              canViewBilling: true,
              canExportData: true,
            },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      ),
    };
    mw = new EffectiveTenantMiddleware(
      lookup,
      impersonationAuthorization,
    );
  });

  afterAll(() => {
    if (originalMfaRequirement === undefined) {
      delete process.env['MFA_REQUIRED_FOR_CROSS_TENANT'];
    } else {
      process.env['MFA_REQUIRED_FOR_CROSS_TENANT'] = originalMfaRequirement;
    }
  });

  it('unauthenticated request: no effective tenant, passes through', async () => {
    const req = mockReq();
    const next = jest.fn();
    await mw.use(req, res, next);
    expect(req.effectiveTenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // A.4: the gateway ALS logging frame (set by RequestContextMiddleware earlier
  // in the chain from the JWT tenant) must be enriched with the EFFECTIVE tenant
  // so every subsequent log line — and a SUPER_ADMIN act-as in particular — is
  // attributed to the tenant the request actually operates on.
  describe('A.4 — ALS logging-frame enrichment', () => {
    it('enriches the active request-context tenantId with the effective tenant', async () => {
      const req = mockReq({ user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] } });
      const seen = await requestContextStorage.run({}, async () => {
        await mw.use(req, res, jest.fn());
        return getRequestContext().tenantId;
      });
      expect(seen).toBe(TENANT_A);
    });

    it('attributes a SUPER_ADMIN act-as to the TARGET tenant in the log frame', async () => {
      const req = superAdminActAs(TENANT_B);
      const seen = await requestContextStorage.run({}, async () => {
        await mw.use(req, res, jest.fn());
        return getRequestContext().tenantId;
      });
      expect(seen).toBe(TENANT_B);
    });

    it('does not throw when no ALS frame is active (enrichment is a safe no-op)', async () => {
      const req = mockReq({ user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] } });
      await expect(mw.use(req, res, jest.fn())).resolves.toBeUndefined();
      expect(req.effectiveTenantId).toBe(TENANT_A);
    });
  });

  describe('regular user', () => {
    it('uses the JWT tenant; ignores no act-as', async () => {
      const req = mockReq({ user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] } });
      await mw.use(req, res, jest.fn());
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(lookup.lookupTenant).not.toHaveBeenCalled();
    });

    it('act-as == own tenant is allowed', async () => {
      const req = mockReq({
        user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] },
        requestedActAsTenant: TENANT_A,
      });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(next).toHaveBeenCalled();
    });

    it('REJECTS cross-tenant act-as (403) — no escalation', async () => {
      const req = mockReq({
        user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] },
        requestedActAsTenant: TENANT_B,
      });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
      expect(req.effectiveTenantId).toBeUndefined();
    });

    it('rejects impersonation credentials on a non-SUPER_ADMIN session', async () => {
      const req = mockReq({
        user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] },
        requestedImpersonationToken: IMPERSONATION_CREDENTIAL,
      });
      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(
        'Impersonation credentials require a SUPER_ADMIN session',
      );
      expect(impersonationAuthorization.resolveContext).not.toHaveBeenCalled();
    });
  });

  describe('SUPER_ADMIN act-as', () => {
    it('resolves a validated, ACTIVE act-as tenant', async () => {
      const req = superAdminActAs(TENANT_A);
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(lookup.lookupTenant).toHaveBeenCalledWith(TENANT_A);
      expect(next).toHaveBeenCalled();
      expect(req.impersonationSessionId).toBe(SESSION_ID);
      expect(req.requestedImpersonationToken).toBeUndefined();
      expect(impersonationReceiptLedgerSnapshot(req)).toMatchObject({
        routeConsumerId: 'POST /graphql',
        expected: [],
        committed: [],
        dispatched: [],
      });
      expect(impersonationAuthorization.resolveContext).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: IMPERSONATION_CREDENTIAL,
          authorization: 'Bearer platform-admin-token',
          targetTenantId: TENANT_A,
        }),
      );
    });

    it('serializes exact receipt commits and rejects overlapping sibling operations', async () => {
      const req = superAdminActAs(TENANT_A);
      await mw.use(req, res, jest.fn());
      const authorize = req.authorizeImpersonationOperations;
      expect(authorize).toBeDefined();
      if (!authorize) throw new TypeError('authorization callback was not installed');
      const operation = {
        authority: 'data.read',
        module: 'farm',
        operation: 'Query.farms',
      } as const;

      expectImpersonationOperationDispatch(req, [operation]);
      await expect(authorize([operation])).resolves.toBeUndefined();
      expect(impersonationReceiptLedgerSnapshot(req)).toMatchObject({
        expected: ['data.read\u0000farm\u0000Query.farms'],
        committed: ['data.read\u0000farm\u0000Query.farms'],
        dispatched: [],
      });
      expect(impersonationAuthorization.authorizeOperations).toHaveBeenCalledWith(
        expect.objectContaining({ authorizationReceiptId: RECEIPT_ID }),
        [operation],
      );
      expect(() => expectImpersonationOperationDispatch(req, [operation])).toThrow(
        'Impersonation operation already entered expected stage',
      );
    });

    it('fails closed for an external route absent from the receipt-consumer catalog', async () => {
      const req = superAdminActAs(TENANT_A, {
        method: 'GET',
        path: '/api/unknown',
        originalUrl: '/api/unknown',
        body: undefined,
        headers: {
          authorization: 'Bearer platform-admin-token',
          'user-agent': 'effective-tenant-test/1.0',
        },
      });

      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(
        'This gateway route does not support impersonation',
      );
      expect(impersonationAuthorization.resolveContext).not.toHaveBeenCalled();
    });

    it('rejects tenant-header-only act-as without the canonical credential', async () => {
      const req = mockReq({
        user: SUPER_ADMIN,
        requestedActAsTenant: TENANT_A,
        headers: { authorization: 'Bearer platform-admin-token' },
      });
      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(
        'Cross-tenant access requires a canonical impersonation credential',
      );
      expect(impersonationAuthorization.resolveContext).not.toHaveBeenCalled();
    });

    it('rejects a credential that the admin authority does not validate', async () => {
      impersonationAuthorization.resolveContext.mockResolvedValueOnce(null);
      await expect(mw.use(superAdminActAs(TENANT_A), res, jest.fn())).rejects.toThrow(
        'Impersonation credential is invalid for this tenant',
      );
      expect(lookup.lookupTenant).not.toHaveBeenCalled();
    });

    it('carries the complete permission snapshot for the downstream operation authority', async () => {
      impersonationAuthorization.resolveContext.mockResolvedValueOnce({
        sessionId: SESSION_ID,
        superAdminId: SUPER_ADMIN.sub,
        targetTenantId: TENANT_A,
        permissions: {
          canViewData: true,
          canModifyData: false,
          canAccessSettings: false,
          canManageUsers: false,
          canViewBilling: false,
          canExportData: false,
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const req = superAdminActAs(TENANT_A, {
        method: 'POST',
        body: { query: 'mutation UpdateFarm { updateFarm(input: {}) { id } }' },
      });
      await expect(mw.use(req, res, jest.fn())).resolves.toBeUndefined();
      expect(req.impersonationSessionId).toBe(SESSION_ID);
      expect(req.impersonationPermissions).toEqual(
        expect.objectContaining({ canViewData: true, canModifyData: false }),
      );
      expect(lookup.lookupTenant).toHaveBeenCalledWith(TENANT_A);
    });

    it('no act-as: system scope (undefined) — fail-closed downstream, not silent wrong-tenant', async () => {
      const req = mockReq({ user: SUPER_ADMIN });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('REJECTS a non-UUID act-as', async () => {
      const req = superAdminActAs('not-a-uuid');
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REJECTS an act-as tenant that is not ACTIVE (suspended)', async () => {
      lookup.lookupTenant.mockResolvedValue({ status: TenantStatus.SUSPENDED });
      const req = superAdminActAs(TENANT_A);
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
      expect(req.effectiveTenantId).toBeUndefined();
    });

    it('REJECTS an act-as tenant that does not exist (lookup null)', async () => {
      lookup.lookupTenant.mockResolvedValue(null);
      const req = superAdminActAs(TENANT_A);
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('requires MFA by default when the deployment omits the configuration', async () => {
      const req = superAdminActAs(TENANT_A, {
        user: { ...SUPER_ADMIN, mfaVerified: false },
      });

      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(
        'MFA step-up is required for cross-tenant access',
      );
    });

    it('does not allow configuration to weaken signed MFA authority', async () => {
      process.env['MFA_REQUIRED_FOR_CROSS_TENANT'] = 'false';
      const req = superAdminActAs(TENANT_A, {
        user: { ...SUPER_ADMIN, mfaVerified: false },
      });

      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(
        'MFA step-up is required for cross-tenant access',
      );
      expect(req.effectiveTenantId).toBeUndefined();
    });
  });
});
