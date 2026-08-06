/**
 * The canary exemption is the reason a synthetic write can be run against
 * production at all. Two properties carry it: a canary is never billed, and
 * a MISCONFIGURED canary is never silently treated as a customer — because
 * that failure produces a small unexplained invoice line months later,
 * which is the hardest kind of billing bug to trace back.
 */
import {
  CANARY_TENANT_IDS_ENV,
  CanaryTenantConfigurationError,
  isCanaryTenant,
  parseCanaryTenantIds,
} from '../canary-tenant.registry';

const CANARY = '11111111-2222-4333-8444-555555555555';
const CUSTOMER = '80424281-4ce3-4e13-b44b-0ea497dc34c4';

describe('canary tenant registry', () => {
  it('treats no configuration as no canary tenants', () => {
    expect(parseCanaryTenantIds(undefined).size).toBe(0);
    expect(parseCanaryTenantIds('').size).toBe(0);
    expect(parseCanaryTenantIds('   ').size).toBe(0);
  });

  it('recognises a configured canary and nobody else', () => {
    const env = { [CANARY_TENANT_IDS_ENV]: CANARY };

    expect(isCanaryTenant(CANARY, env)).toBe(true);
    expect(isCanaryTenant(CUSTOMER, env)).toBe(false);
  });

  it('accepts several canaries and tolerates operator spacing', () => {
    const second = '99999999-8888-4777-8666-555555555555';
    const env = { [CANARY_TENANT_IDS_ENV]: ` ${CANARY} , ${second} ` };

    expect(isCanaryTenant(CANARY, env)).toBe(true);
    expect(isCanaryTenant(second, env)).toBe(true);
  });

  it('matches regardless of the case the id was written in', () => {
    const env = { [CANARY_TENANT_IDS_ENV]: CANARY.toUpperCase() };

    expect(isCanaryTenant(CANARY, env)).toBe(true);
  });

  it('refuses a malformed id instead of dropping it', () => {
    // The dangerous version of this bug is silent: a typo'd canary id looks
    // exempt in the config and gets billed in reality.
    expect(() => parseCanaryTenantIds(`${CANARY},not-a-uuid`)).toThrow(
      CanaryTenantConfigurationError,
    );
    expect(() => parseCanaryTenantIds(`${CANARY},not-a-uuid`)).toThrow(/not-a-uuid/);
  });

  it('never treats an empty or absent tenant id as a canary', () => {
    const env = { [CANARY_TENANT_IDS_ENV]: CANARY };

    expect(isCanaryTenant('', env)).toBe(false);
    expect(isCanaryTenant('   ', env)).toBe(false);
  });

  it('reflects a configuration change without a restart', () => {
    // Cached membership would keep exempting a tenant the operator just
    // removed - the exemption must be as revocable as it is grantable.
    const before = { [CANARY_TENANT_IDS_ENV]: CANARY };
    const after = { [CANARY_TENANT_IDS_ENV]: '' };

    expect(isCanaryTenant(CANARY, before)).toBe(true);
    expect(isCanaryTenant(CANARY, after)).toBe(false);
  });
});
