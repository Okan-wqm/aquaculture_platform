import { ForbiddenException } from '@nestjs/common';
import { TenantStatus } from '@platform/event-contracts';
import type { Response } from 'express';

import { getRequestContext, requestContextStorage } from '../../logging';
import {
  ACT_AS_REASON_MAX_LENGTH,
  CaptureRequestedTenantMiddleware,
  EffectiveTenantMiddleware,
  type ActAsPrincipal,
  type RequestWithEffectiveTenant,
} from '../effective-tenant.middleware';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const REASON = 'Support ticket: water-quality export failing for the customer';

type MockUser = Partial<ActAsPrincipal> & { mfaVerified?: boolean };

function mockReq(
  over: {
    headers?: Record<string, string>;
    user?: MockUser;
    requestedActAsTenant?: string;
    requestedActAsReason?: string;
    requestedActAsTicket?: string;
  } = {},
): RequestWithEffectiveTenant {
  return { headers: {}, ...over } as RequestWithEffectiveTenant;
}
const res = {} as Response;

// A SUPER_ADMIN platform account omits tenantId (null at runtime) — undefined
// here exercises the same `?? null`/`?? undefined` paths in the middleware.
const SUPER_ADMIN: MockUser = {
  sub: 'admin',
  roles: ['SUPER_ADMIN'],
  mfaVerified: true,
};

/** A super admin acting on TENANT_A with the justification ADR-0007 requires. */
function superAdminActAs(
  over: Partial<Parameters<typeof mockReq>[0]> = {},
): RequestWithEffectiveTenant {
  return mockReq({
    user: SUPER_ADMIN,
    requestedActAsTenant: TENANT_A,
    requestedActAsReason: REASON,
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
    expect(req.requestedActAsReason).toBeUndefined();
    expect(req.requestedActAsTicket).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('captures the trimmed reason and ticket as untrusted intent', () => {
    const req = mockReq({
      headers: { 'x-act-as-reason': `  ${REASON}  `, 'x-act-as-ticket': ' SUP-1234 ' },
    });
    mw.use(req, res, jest.fn());
    expect(req.requestedActAsReason).toBe(REASON);
    expect(req.requestedActAsTicket).toBe('SUP-1234');
  });
});

describe('EffectiveTenantMiddleware', () => {
  let lookup: { lookupTenant: jest.Mock };
  let mw: EffectiveTenantMiddleware;
  const originalMfaRequirement = process.env['MFA_REQUIRED_FOR_CROSS_TENANT'];

  beforeEach(() => {
    delete process.env['MFA_REQUIRED_FOR_CROSS_TENANT'];
    lookup = { lookupTenant: jest.fn().mockResolvedValue({ status: TenantStatus.ACTIVE }) };
    mw = new EffectiveTenantMiddleware(lookup);
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

  // The ALS logging frame (set by RequestContextMiddleware earlier in the
  // chain from the JWT tenant) must be enriched with the EFFECTIVE tenant so
  // every subsequent log line — and a SUPER_ADMIN act-as in particular — is
  // attributed to the tenant the request actually operates on.
  describe('ALS logging-frame enrichment', () => {
    it('enriches the active request-context tenantId with the effective tenant', async () => {
      const req = mockReq({ user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] } });
      const seen = await requestContextStorage.run({}, async () => {
        await mw.use(req, res, jest.fn());
        return getRequestContext().tenantId;
      });
      expect(seen).toBe(TENANT_A);
    });

    it('attributes a SUPER_ADMIN act-as to the TARGET tenant in the log frame', async () => {
      const req = superAdminActAs({ requestedActAsTenant: TENANT_B });
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

    it('act-as == own tenant is allowed and needs no reason', async () => {
      const req = mockReq({
        user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] },
        requestedActAsTenant: TENANT_A,
      });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(req.actAs).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('REJECTS cross-tenant act-as (403) — no escalation, whatever reason is offered', async () => {
      const req = mockReq({
        user: { sub: 'u1', tenantId: TENANT_A, roles: ['FARMER'] },
        requestedActAsTenant: TENANT_B,
        requestedActAsReason: REASON,
      });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
      expect(req.effectiveTenantId).toBeUndefined();
    });
  });

  describe('SUPER_ADMIN act-as', () => {
    it('resolves a validated, ACTIVE act-as tenant and records the act-as context', async () => {
      const req = superAdminActAs({ requestedActAsTicket: 'SUP-1234' });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(req.actAs).toEqual({
        homeTenantId: null,
        targetTenantId: TENANT_A,
        reason: REASON,
        ticket: 'SUP-1234',
        mfaVerified: true,
      });
      expect(lookup.lookupTenant).toHaveBeenCalledWith(TENANT_A);
      expect(next).toHaveBeenCalled();
    });

    it('REJECTS a cross-tenant act-as without X-Act-As-Reason (ADR-0007: access is justified, not silent)', async () => {
      const req = superAdminActAs({ requestedActAsReason: undefined });
      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(/requires a justification/);
      expect(req.effectiveTenantId).toBeUndefined();
      expect(req.actAs).toBeUndefined();
    });

    it('REJECTS a reason longer than the audit column budget', async () => {
      const req = superAdminActAs({
        requestedActAsReason: 'x'.repeat(ACT_AS_REASON_MAX_LENGTH + 1),
      });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REJECTS a ticket reference that is not a ticket reference', async () => {
      const req = superAdminActAs({ requestedActAsTicket: 'drop table; --' });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('records a null ticket when none is supplied', async () => {
      const req = superAdminActAs();
      await mw.use(req, res, jest.fn());
      expect(req.actAs?.ticket).toBeNull();
    });

    it('no act-as: system scope (undefined) — fail-closed downstream, not silent wrong-tenant', async () => {
      const req = mockReq({ user: SUPER_ADMIN });
      const next = jest.fn();
      await mw.use(req, res, next);
      expect(req.effectiveTenantId).toBeUndefined();
      expect(req.actAs).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it('REJECTS a non-UUID act-as', async () => {
      const req = superAdminActAs({ requestedActAsTenant: 'not-a-uuid' });
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REJECTS an act-as tenant that is not ACTIVE (suspended)', async () => {
      lookup.lookupTenant.mockResolvedValue({ status: TenantStatus.SUSPENDED });
      const req = superAdminActAs();
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
      expect(req.effectiveTenantId).toBeUndefined();
    });

    it('REJECTS an act-as tenant that does not exist (lookup null)', async () => {
      lookup.lookupTenant.mockResolvedValue(null);
      const req = superAdminActAs();
      await expect(mw.use(req, res, jest.fn())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('requires MFA by default when the deployment omits the configuration', async () => {
      const req = superAdminActAs({ user: { ...SUPER_ADMIN, mfaVerified: false } });
      await expect(mw.use(req, res, jest.fn())).rejects.toThrow(
        'MFA step-up is required for cross-tenant access',
      );
    });

    it('allows an explicit MFA opt-out only when configured as false, and records mfaVerified truthfully', async () => {
      process.env['MFA_REQUIRED_FOR_CROSS_TENANT'] = 'false';
      const req = superAdminActAs({ user: { ...SUPER_ADMIN, mfaVerified: false } });
      await expect(mw.use(req, res, jest.fn())).resolves.toBeUndefined();
      expect(req.effectiveTenantId).toBe(TENANT_A);
      expect(req.actAs?.mfaVerified).toBe(false);
    });

    it('fails CLOSED in production when no tenant-ACTIVE port is bound', async () => {
      const originalNodeEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        const unbound = new EffectiveTenantMiddleware();
        await expect(unbound.use(superAdminActAs(), res, jest.fn())).rejects.toThrow(
          /TENANT_ACTIVE_CHECK/,
        );
      } finally {
        if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = originalNodeEnv;
      }
    });
  });
});
