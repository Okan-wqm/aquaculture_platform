import { ForbiddenException } from '@nestjs/common';
import { TenantStatus } from '@platform/event-contracts';
import { getRequestContext, requestContextStorage } from '@aquaculture/backend-common/logging';
import type { Response } from 'express';

import { JwtPayload } from '../guards/auth.guard';

import {
  CaptureRequestedTenantMiddleware,
  EffectiveTenantMiddleware,
  RequestWithEffectiveTenant,
} from './effective-tenant.middleware';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

type MockUser = Partial<JwtPayload> & { mfaVerified?: boolean };

function mockReq(
  over: { headers?: Record<string, string>; user?: MockUser; requestedActAsTenant?: string } = {},
): RequestWithEffectiveTenant {
  return { headers: {}, ...over } as RequestWithEffectiveTenant;
}
const res = {} as Response;

// A SUPER_ADMIN platform account omits tenantId (null at runtime) — undefined
// here exercises the same `?? null`/`?? undefined` paths in the middleware.
const SUPER_ADMIN: MockUser = { sub: 'admin', roles: ['SUPER_ADMIN'] };

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
});

describe('EffectiveTenantMiddleware', () => {
  let lookup: { lookupTenant: jest.Mock };
  let mw: EffectiveTenantMiddleware;

  beforeEach(() => {
    lookup = { lookupTenant: jest.fn().mockResolvedValue({ status: TenantStatus.ACTIVE }) };
    mw = new EffectiveTenantMiddleware(lookup);
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
      const req = mockReq({ user: SUPER_ADMIN, requestedActAsTenant: TENANT_B });
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
  });

  describe('SUPER_ADMIN act-as', () => {
    it('resolves a validated, ACTIVE act-as tenant', async () => {
      const req = mockReq({ user: SUPER_ADMIN, requestedActAsTenant: TENANT_A });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(lookup.lookupTenant).toHaveBeenCalledWith(TENANT_A);
      expect(next).toHaveBeenCalled();
    });

    it('no act-as: system scope (undefined) — fail-closed downstream, not silent wrong-tenant', async () => {
      const req = mockReq({ user: SUPER_ADMIN });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('REJECTS a non-UUID act-as', async () => {
      const req = mockReq({ user: SUPER_ADMIN, requestedActAsTenant: 'not-a-uuid' });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REJECTS an act-as tenant that is not ACTIVE (suspended)', async () => {
      lookup.lookupTenant.mockResolvedValue({ status: TenantStatus.SUSPENDED });
      const req = mockReq({ user: SUPER_ADMIN, requestedActAsTenant: TENANT_A });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
      expect(req.effectiveTenantId).toBeUndefined();
    });

    it('REJECTS an act-as tenant that does not exist (lookup null)', async () => {
      lookup.lookupTenant.mockResolvedValue(null);
      const req = mockReq({ user: SUPER_ADMIN, requestedActAsTenant: TENANT_A });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
