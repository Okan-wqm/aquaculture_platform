import 'reflect-metadata';
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  isCapability,
  knownCapabilities,
} from '../capabilities';
import { Role } from '../../decorators/roles.decorator';
import {
  DEFAULT_ROLE_CAPABILITIES,
  hasCapability,
  resolveEffectiveCapabilities,
} from '../permission-resolver';

/**
 * Faz 7 RBAC foundation — capability catalogue + effective-capability resolution.
 */
describe('capability catalogue (SSoT)', () => {
  it('exposes every catalogue value in ALL_CAPABILITIES with no duplicates', () => {
    const values = Object.values(CAPABILITIES);
    expect(new Set(values).size).toBe(values.length);
    expect([...ALL_CAPABILITIES].sort()).toEqual([...values].sort());
  });

  it('every capability follows the resource:action wire format', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z0-9-]+:[a-z0-9-]+$/);
    }
  });

  it('isCapability accepts catalogue strings and rejects unknowns', () => {
    expect(isCapability(CAPABILITIES.aiChatUse)).toBe(true);
    expect(isCapability('made-up:action')).toBe(false);
    expect(isCapability('')).toBe(false);
  });

  it('knownCapabilities drops unknown/renamed strings (drift-safe)', () => {
    expect(
      knownCapabilities([CAPABILITIES.aiChatUse, 'ghost:cap', CAPABILITIES.rbacRoleManage]),
    ).toEqual([CAPABILITIES.aiChatUse, CAPABILITIES.rbacRoleManage]);
  });
});

describe('resolveEffectiveCapabilities', () => {
  it('a plain MODULE_USER gets the WhatsApp-like member floor (chat + DM + group + operator persona)', () => {
    const caps = resolveEffectiveCapabilities({ roles: ['MODULE_USER'] });
    expect(caps).toEqual(expect.arrayContaining([
      CAPABILITIES.aiChatUse,
      CAPABILITIES.messagingDmCreate,
      CAPABILITIES.messagingGroupCreate,
      CAPABILITIES.aiPersonaOperator,
    ]));
    // …but NOT the sensitive ones.
    expect(caps).not.toContain(CAPABILITIES.aiConfigManage);
    expect(caps).not.toContain(CAPABILITIES.aiPersonaSupervisor);
    expect(caps).not.toContain(CAPABILITIES.rbacRoleManage);
  });

  it('TENANT_ADMIN gets the whole catalogue', () => {
    const caps = resolveEffectiveCapabilities({ roles: ['TENANT_ADMIN'] });
    expect(caps.sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it('uses the HIGHEST role in a multi-role set for the floor', () => {
    const caps = resolveEffectiveCapabilities({
      roles: ['MODULE_USER', 'MODULE_MANAGER'],
    });
    expect(caps).toContain(CAPABILITIES.aiPersonaExpert); // manager floor
  });

  it('unions tenant custom grants on top of the role floor and dedupes', () => {
    const caps = resolveEffectiveCapabilities({
      roles: ['MODULE_USER'],
      tenantGrants: [CAPABILITIES.aiConfigManage, CAPABILITIES.aiChatUse],
    });
    expect(caps).toContain(CAPABILITIES.aiConfigManage); // granted on top
    expect(caps.filter((c) => c === CAPABILITIES.aiChatUse)).toHaveLength(1); // deduped
  });

  it('drops unknown tenant grants (fail-closed against config drift)', () => {
    const caps = resolveEffectiveCapabilities({
      roles: ['MODULE_USER'],
      tenantGrants: ['totally:bogus'],
    });
    expect(caps).not.toContain('totally:bogus');
  });

  it('an empty/unknown role set gets the MODULE_USER floor (fail-closed)', () => {
    const empty = resolveEffectiveCapabilities({ roles: [] });
    const unknown = resolveEffectiveCapabilities({ roles: ['WAT'] });
    expect(empty).toEqual(DEFAULT_ROLE_CAPABILITIES[Role.MODULE_USER]);
    expect(unknown).toEqual(DEFAULT_ROLE_CAPABILITIES[Role.MODULE_USER]);
  });

  it('returns capabilities in stable catalogue order', () => {
    const a = resolveEffectiveCapabilities({ roles: ['TENANT_ADMIN'] });
    const b = resolveEffectiveCapabilities({ roles: ['TENANT_ADMIN'] });
    expect(a).toEqual(b);
    expect(a).toEqual(ALL_CAPABILITIES.filter((c) => a.includes(c)));
  });
});

describe('hasCapability', () => {
  it('is a membership check over a resolved set', () => {
    const caps = resolveEffectiveCapabilities({ roles: ['MODULE_USER'] });
    expect(hasCapability(caps, CAPABILITIES.aiChatUse)).toBe(true);
    expect(hasCapability(caps, CAPABILITIES.rbacRoleManage)).toBe(false);
  });
});
