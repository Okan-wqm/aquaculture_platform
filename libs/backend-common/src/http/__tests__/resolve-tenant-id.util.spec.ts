import { resolveTenantIdFromRequest } from '../resolve-tenant-id.util';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';

describe('resolveTenantIdFromRequest', () => {
  it('prefers signed farm effective tenant over server and user context', () => {
    expect(
      resolveTenantIdFromRequest({
        farmVerifiedIdentity: { effectiveTenantId: TENANT_A },
        tenantId: TENANT_B,
        user: { tenantId: TENANT_C },
      }),
    ).toBe(TENANT_A);
  });

  it('uses server-set tenant before user tenant', () => {
    expect(
      resolveTenantIdFromRequest({
        tenantId: TENANT_B,
        user: { tenantId: TENANT_C },
      }),
    ).toBe(TENANT_B);
  });

  it('does not use raw x-tenant-id as tenant authority', () => {
    expect(
      resolveTenantIdFromRequest({
        headers: { 'x-tenant-id': TENANT_A },
      }),
    ).toBe('');
  });

  it('returns empty string for malformed verified candidates', () => {
    expect(
      resolveTenantIdFromRequest({
        farmVerifiedIdentity: { effectiveTenantId: 'bad-tenant' },
        tenantId: 'also-bad',
        user: { tenantId: 'not-a-uuid' },
      }),
    ).toBe('');
  });
});
