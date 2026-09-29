import { TenantBinding, UntrustedTenantError } from '../tenant-binding';
import {
  buildConfirmedProposalContext,
  buildHumanTurnContext,
  buildServicePrincipalContext,
} from '../tool-context.factory';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

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

  it('is frozen: its tenant cannot be swapped while the brand is kept (V-T1a-1)', () => {
    // SCENARIO: code keeps the genuine binding and rewrites its tenant at runtime.
    // EXPECTS: the write fails (frozen), so isGenuine can never vouch for a swapped tenant.
    const binding = TenantBinding.fromTrustedRequest(TENANT);
    expect(Reflect.set(binding, 'tenantId', OTHER)).toBe(false);
    expect(() => Object.assign(binding, { tenantId: OTHER })).toThrow(TypeError);
    expect(binding.tenantId).toBe(TENANT);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it.each([
    [
      'human turn',
      () =>
        buildHumanTurnContext({
          tenantId: TENANT,
          userId: 'u',
          userRoles: ['MODULE_USER'],
          correlationId: 'c',
          persona: 'operator-v1',
          personaTier: 'operator',
          offeredToolNames: ['get_tank_capacity'],
          actuationPolicy: 'confirm_required',
        }),
    ],
    [
      'confirmed proposal',
      () =>
        buildConfirmedProposalContext({
          tenantId: TENANT,
          requestedBy: 'u',
          requesterRoles: ['MODULE_USER'],
          correlationId: 'c',
          persona: 'operator-v1',
          personaTier: 'operator',
          toolName: 'create_task',
        }),
    ],
    [
      'service principal',
      () =>
        buildServicePrincipalContext({
          tenantId: TENANT,
          serviceName: 'sensor-service',
          grantedToolNames: ['suggest_channels'],
          correlationId: 'c',
        }),
    ],
  ])(
    'the %s context is frozen with its arrays — one turn cannot re-bind the next call',
    (_kind, build) => {
      // SCENARIO: a tool mutates the shared turn context (tenant, grants, roles).
      // EXPECTS: every write throws; the next tool call and the audit row see the original values.
      const ctx = build();
      expect(() => Object.assign(ctx, { tenant: TenantBinding.fromTrustedRequest(OTHER) })).toThrow(
        TypeError,
      );
      expect(() => Object.assign(ctx.offeredToolNames, ['create_task'])).toThrow(TypeError);
      expect(() => Object.assign(ctx.userRoles, ['TENANT_ADMIN'])).toThrow(TypeError);
      if (ctx.servicePrincipal !== undefined) {
        expect(() => Object.assign(ctx.servicePrincipal?.grantedToolNames ?? [], ['x'])).toThrow(
          TypeError,
        );
      }
      expect(ctx.tenant.tenantId).toBe(TENANT);
    },
  );
});
