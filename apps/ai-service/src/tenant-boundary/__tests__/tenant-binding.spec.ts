import { TenantBinding, UntrustedTenantError } from '../tenant-binding';
import { buildHumanTurnContext } from '../tool-context.factory';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** K10 layer 1 (MT-HIGH-062): the tenant a tool may touch is a minted binding, not a string. */
describe('TenantBinding', () => {
  it('mints from a trusted UUID and derives the schema through the platform SSoT', () => {
    const binding = TenantBinding.fromTrustedRequest(TENANT);
    expect(binding.tenantId).toBe(TENANT);
    expect(binding.schemaName).toBe('tenant_1111111111114111');
    expect(TenantBinding.isGenuine(binding)).toBe(true);
  });

  it.each([undefined, '', 'tenant_1111111111114111', 42, { tenantId: TENANT }])(
    'refuses to mint from %p',
    (raw) => {
      expect(() => TenantBinding.fromTrustedRequest(raw)).toThrow(UntrustedTenantError);
    },
  );

  it('a structural copy is not genuine — a cast cannot forge a binding', () => {
    // SCENARIO: code builds an object with the same public fields.
    // EXPECTS: the ES private brand is missing, so the runtime check rejects it.
    const copy = { tenantId: TENANT, schemaName: 'tenant_1111111111114111' };
    expect(TenantBinding.isGenuine(copy)).toBe(false);
    expect(TenantBinding.isGenuine({ ...TenantBinding.fromTrustedRequest(TENANT) })).toBe(false);
  });

  it('the context factory mints the binding from the request it is given', () => {
    const ctx = buildHumanTurnContext({
      tenantId: TENANT,
      userId: 'u',
      userRoles: [],
      correlationId: 'c',
      persona: 'operator-v1',
      personaTier: 'operator',
      offeredToolNames: [],
      actuationPolicy: 'confirm_required',
    });
    expect(TenantBinding.isGenuine(ctx.tenant)).toBe(true);
    expect(ctx.tenant.tenantId).toBe(TENANT);
  });
});
