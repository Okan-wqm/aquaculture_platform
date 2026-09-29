import {
  isTenantBoundReply,
  verifyTenantBoundReply,
  type TenantBoundReply,
} from '../tenant-bound-reply';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const isNumberList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number');

/**
 * Tenant-bound reply contract (K10 / MT-HIGH-062): every AI-facing reply names
 * the tenant it served, and the consumer check refuses a foreign one before
 * the data is read.
 */
describe('isTenantBoundReply', () => {
  it('accepts both arms only when they name a tenant', () => {
    // SCENARIO: the two legal envelope shapes, plus the null echo of an unparseable tenant.
    // EXPECTS: all three are envelopes.
    expect(isTenantBoundReply({ ok: true, tenantId: TENANT_A, data: [] })).toBe(true);
    expect(isTenantBoundReply({ ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' })).toBe(true);
    expect(isTenantBoundReply({ ok: false, tenantId: null, error: 'INVALID_REQUEST' })).toBe(true);
  });

  it('rejects the pre-K10 envelope, bare arrays and unknown error codes', () => {
    // SCENARIO: a reply from a responder that predates the tenant echo.
    // EXPECTS: not an envelope, so no consumer can read its data.
    expect(isTenantBoundReply({ ok: true, data: [] })).toBe(false);
    expect(isTenantBoundReply({ ok: false, error: 'INTERNAL_ERROR' })).toBe(false);
    expect(isTenantBoundReply([])).toBe(false);
    expect(isTenantBoundReply({ ok: false, tenantId: TENANT_A, error: 'SOMETHING' })).toBe(false);
  });
});

describe('verifyTenantBoundReply', () => {
  it('returns the data only when the served tenant is the requested one', () => {
    // SCENARIO: a well-formed reply for the tenant that asked.
    // EXPECTS: kind data with the payload.
    const reply: TenantBoundReply<number[]> = { ok: true, tenantId: TENANT_A, data: [1, 2] };
    expect(verifyTenantBoundReply(reply, TENANT_A, isNumberList)).toEqual({
      kind: 'data',
      data: [1, 2],
    });
  });

  it('classifies a reply served for another tenant as a mismatch and never reads its data', () => {
    // SCENARIO: tenant A asked; the reply names tenant B and carries B's rows.
    // EXPECTS: tenant_mismatch, and the data guard is never invoked on B's rows.
    const isData = jest.fn(isNumberList);
    const verdict = verifyTenantBoundReply(
      { ok: true, tenantId: TENANT_B, data: [42] },
      TENANT_A,
      (value): value is number[] => isData(value),
    );
    expect(verdict).toEqual({ kind: 'tenant_mismatch', servedTenantId: TENANT_B });
    expect(isData).not.toHaveBeenCalled();
  });

  it('treats a foreign or missing tenant on a failure reply as a mismatch too', () => {
    // SCENARIO: error replies naming another tenant, or no tenant at all.
    // EXPECTS: mismatch — the tenant check runs before `ok` is read.
    expect(
      verifyTenantBoundReply(
        { ok: false, tenantId: TENANT_B, error: 'NOT_FOUND' },
        TENANT_A,
        isNumberList,
      ),
    ).toEqual({ kind: 'tenant_mismatch', servedTenantId: TENANT_B });
    expect(
      verifyTenantBoundReply(
        { ok: false, tenantId: null, error: 'INVALID_REQUEST' },
        TENANT_A,
        isNumberList,
      ),
    ).toEqual({ kind: 'tenant_mismatch', servedTenantId: null });
  });

  it('surfaces the transport error of a same-tenant failure', () => {
    // SCENARIO: the responder served tenant A but the id did not exist there.
    // EXPECTS: kind error with NOT_FOUND.
    expect(
      verifyTenantBoundReply(
        { ok: false, tenantId: TENANT_A, error: 'NOT_FOUND' },
        TENANT_A,
        isNumberList,
      ),
    ).toEqual({ kind: 'error', error: 'NOT_FOUND' });
  });

  it('flags a non-envelope and a same-tenant payload that fails the data contract as malformed', () => {
    // SCENARIO: a legacy bare array, then a same-tenant reply with the wrong data shape.
    // EXPECTS: malformed/envelope and malformed/contract respectively.
    expect(verifyTenantBoundReply([1], TENANT_A, isNumberList)).toEqual({
      kind: 'malformed',
      reason: 'envelope',
    });
    expect(
      verifyTenantBoundReply({ ok: true, tenantId: TENANT_A, data: ['x'] }, TENANT_A, isNumberList),
    ).toEqual({ kind: 'malformed', reason: 'contract' });
  });
});
