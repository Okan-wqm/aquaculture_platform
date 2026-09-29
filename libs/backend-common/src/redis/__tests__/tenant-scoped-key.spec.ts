import { tenantScopedKey } from '../tenant-scoped-key';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** K10 layer 5 (MT-HIGH-062): AI cache/counter keys carry the tenant as the first variable segment. */
describe('tenantScopedKey', () => {
  it('builds <family>:<tenantId>:<parts…>', () => {
    expect(tenantScopedKey('ai:tokens', TENANT, '2026-09')).toBe(`ai:tokens:${TENANT}:2026-09`);
    expect(tenantScopedKey('msg:ai-daily', TENANT, 'chan', 20260929)).toBe(
      `msg:ai-daily:${TENANT}:chan:20260929`,
    );
    expect(tenantScopedKey('ai:tenant', TENANT)).toBe(`ai:tenant:${TENANT}`);
  });

  it.each(['', 'tenant_1111', 'undefined'])(
    'refuses a non-UUID tenant %p (fails closed)',
    (tenantId) => {
      // SCENARIO: an empty/garbled tenant would collapse all tenants into one key.
      // EXPECTS: a throw, never a shared key.
      expect(() => tenantScopedKey('ai:tokens', tenantId, 'x')).toThrow(/tenant UUID/);
    },
  );

  it.each(['', 'AI:tokens', 'ai::tokens', 'ai:tokens:', `ai:${TENANT}`])(
    'refuses a malformed family %p',
    (family) => {
      expect(() => tenantScopedKey(family, TENANT)).toThrow(/invalid key family/);
    },
  );
});
