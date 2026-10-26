import {
  AI_PERSONA_CATALOGUE,
  AI_PERSONA_TIERS,
  AI_SPECIALTY_CATALOGUE,
  AI_SPECIALTY_IDS,
  AI_SPECIALTY_MODULE_CODES,
  type AiPersonaCapability,
} from '../..';
import {
  COMPANY_VIEW_CAPABILITY,
  EDGE_DEVICE_IO_CONFIG_CAPABILITY,
  TENANT_CAPABILITIES,
  TENANT_CAPABILITY_CATALOGUE,
  holdsTenantCapabilities,
  isTenantCapability,
  type TenantCapability,
  type TenantCapabilityCategoryKey,
  type TenantCapabilityPanel,
} from '../tenant-capabilities';

/**
 * The tenant capability vocabulary (RBAC-MEDIUM-024; ADR-051 §1 `account(capability)`): the
 * catalogue the role editor, the token mint and the write-time grant authority read, and the one
 * capability check — the account-role bypass included — that the backend
 * `hasAllResourcePermissions`, the web `hasResourcePermission` and `decideAccess` share.
 *
 * PKG-03 (RBAC-HIGH-025, RBAC-MEDIUM-026): the catalogue offers only what a check reads. The 81
 * keys no backend check read are gone; `company:view` (the Company layer, ADR-051 §1) and
 * `edge_devices:manage_io_config` (enforced by sensor-service, ungrantable before) are added; the
 * AI persona tiers and specialties come from the AI catalogue. Which key has which reader is
 * pinned by tests/invariants/tenant-capability-usage.spec.ts.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Includes<U, T> = [T] extends [U] ? true : false;

describe('tenant capability catalogue', () => {
  it('holds the categories whose keys a check reads, plus the Company layer', () => {
    expect(Object.keys(TENANT_CAPABILITY_CATALOGUE)).toEqual([
      'company',
      'admin',
      'hr',
      'sensor',
      'messaging',
      'ai',
      'ai_specialists',
    ]);
    expect(TENANT_CAPABILITY_CATALOGUE.hr.resources.hr_finance).toEqual({
      name: 'HR Finance',
      actions: ['view_salary'],
    });
    expect(TENANT_CAPABILITY_CATALOGUE.sensor.resources.edge_devices.actions).toEqual([
      'manage_io_config',
    ]);
    expect(TENANT_CAPABILITY_CATALOGUE.company.resources.company.actions).toEqual(['view']);
  });

  it('offers exactly the read keys, company:view and the web-read settings:view (release R1)', () => {
    expect([...TENANT_CAPABILITIES]).toEqual([
      'company:view',
      'settings:view',
      'users:view',
      'users:invite',
      'users:edit_permissions',
      'users:deactivate',
      'roles:view',
      'roles:create',
      'roles:edit',
      'roles:delete',
      'hr_finance:view_salary',
      'edge_devices:manage_io_config',
      'channels:create_group',
      'ai_assistant:use',
      'ai_settings:view',
      'ai_settings:manage',
      'ai_personas:operator',
      'ai_personas:manager',
      'ai_personas:expert',
      'ai_personas:supervisor',
      'ai_specialties:farm',
    ]);
  });

  it('flattens to unique `resource:action` capabilities, one per catalogue action', () => {
    const expected = Object.values(TENANT_CAPABILITY_CATALOGUE).flatMap((category) =>
      Object.entries(category.resources).flatMap(([resource, definition]) =>
        definition.actions.map((action) => `${resource}:${action}`),
      ),
    );
    expect(TENANT_CAPABILITIES).toEqual(expected);
    expect(new Set(TENANT_CAPABILITIES).size).toBe(TENANT_CAPABILITIES.length);
  });

  it('narrows a string to a catalogue capability only when the catalogue declares it', () => {
    expect(isTenantCapability('roles:edit')).toBe(true);
    expect(isTenantCapability('edge_devices:manage_io_config')).toBe(true);
    expect(isTenantCapability('company:view')).toBe(true);
    expect(isTenantCapability('roles:fly')).toBe(false);
    expect(isTenantCapability('settings')).toBe(false);
    // Removed: no backend check read them (RBAC-HIGH-025) …
    expect(isTenantCapability('batches:create')).toBe(false);
    expect(isTenantCapability('employees:view')).toBe(false);
    expect(isTenantCapability('settings:edit')).toBe(false);
    expect(isTenantCapability('messages:send')).toBe(false);
    // … and the spelling sensor-service enforced is replaced by the catalogue key.
    expect(isTenantCapability('edge:manage-io-config')).toBe(false);
    const typed: [
      Includes<TenantCapability, 'users:view'>,
      Includes<TenantCapability, 'company:view'>,
      Includes<TenantCapability, 'edge_devices:manage_io_config'>,
      Includes<TenantCapability, 'batches:merge'>,
      Includes<TenantCapability, 'settings:edit'>,
      Includes<TenantCapability, 'edge:manage-io-config'>,
      Includes<TenantCapability, 'users:fly'>,
    ] = [true, true, true, false, false, false, false];
    expect(typed).toEqual([true, true, true, false, false, false, false]);
  });

  it('names the Company read capability as a catalogue key (plan D1, D2; ADR-051 §1)', () => {
    const literal: Equals<typeof COMPANY_VIEW_CAPABILITY, 'company:view'> = true;
    const declared: Includes<TenantCapability, typeof COMPANY_VIEW_CAPABILITY> = true;
    expect([literal, declared]).toEqual([true, true]);
    expect(isTenantCapability(COMPANY_VIEW_CAPABILITY)).toBe(true);
  });

  it('names the edge-device I/O capability sensor-service enforces (RBAC-MEDIUM-026)', () => {
    const literal: Equals<
      typeof EDGE_DEVICE_IO_CONFIG_CAPABILITY,
      'edge_devices:manage_io_config'
    > = true;
    expect(literal).toBe(true);
    expect(isTenantCapability(EDGE_DEVICE_IO_CONFIG_CAPABILITY)).toBe(true);
  });

  it('is frozen at every level', () => {
    const levels: unknown[] = [TENANT_CAPABILITY_CATALOGUE, TENANT_CAPABILITIES];
    for (const category of Object.values(TENANT_CAPABILITY_CATALOGUE)) {
      levels.push(category, category.resources);
      for (const definition of Object.values(category.resources)) {
        levels.push(definition, definition.actions);
      }
    }
    for (const level of levels) {
      expect(Object.isFrozen(level)).toBe(true);
    }
  });
});

describe('the AI capabilities come from the AI catalogue (plan PKG-03)', () => {
  it('ai_personas offers every persona tier', () => {
    expect(TENANT_CAPABILITY_CATALOGUE.ai.resources.ai_personas.actions).toEqual([
      ...AI_PERSONA_TIERS,
    ]);
  });

  it('ai_specialties offers every module a published specialty requires, once', () => {
    const required = AI_SPECIALTY_IDS.flatMap((id) => {
      const specialty = AI_SPECIALTY_CATALOGUE[id];
      return specialty.requiresModule !== null && specialty.publishedTiers.length > 0
        ? [specialty.requiresModule]
        : [];
    });
    expect([...AI_SPECIALTY_MODULE_CODES]).toEqual([...new Set(required)]);
    expect(TENANT_CAPABILITY_CATALOGUE.ai_specialists.resources.ai_specialties.actions).toEqual([
      ...AI_SPECIALTY_MODULE_CODES,
    ]);
    expect([...AI_SPECIALTY_MODULE_CODES]).toEqual(['farm']);
  });

  it('every capability a persona requires is a catalogue capability, by type and by value', () => {
    const assignable: Includes<TenantCapability, AiPersonaCapability> = true;
    expect(assignable).toBe(true);
    for (const entry of AI_PERSONA_CATALOGUE) {
      for (const capability of entry.requiredCapabilities) {
        expect({ persona: entry.id, capability, declared: isTenantCapability(capability) }).toEqual(
          { persona: entry.id, capability, declared: true },
        );
      }
    }
  });
});

describe('TenantCapabilityPanel (a role panel typed by the catalogue)', () => {
  it('names exactly the catalogue categories, resources and actions', () => {
    const categories: Equals<keyof TenantCapabilityPanel, TenantCapabilityCategoryKey> = true;
    const sensor: Equals<keyof NonNullable<TenantCapabilityPanel['sensor']>, 'edge_devices'> = true;
    const actions: Equals<
      keyof NonNullable<NonNullable<TenantCapabilityPanel['admin']>['users']>,
      'view' | 'invite' | 'edit_permissions' | 'deactivate'
    > = true;
    expect([categories, sensor, actions]).toEqual([true, true, true]);
  });
});

describe('holdsTenantCapabilities (the one capability check)', () => {
  it.each(['SUPER_ADMIN', 'TENANT_ADMIN'] as const)(
    '%s holds every capability, with an empty claim',
    (accountRole) => {
      expect(
        holdsTenantCapabilities({ accountRole, capabilities: [] }, ['users:view', 'roles:edit']),
      ).toBe(true);
      expect(
        holdsTenantCapabilities({ accountRole, capabilities: [] }, [COMPANY_VIEW_CAPABILITY]),
      ).toBe(true);
    },
  );

  it('a member holds exactly the capabilities of the claim, all of them required', () => {
    const member = { accountRole: null, capabilities: ['users:view', 'company:view'] };
    expect(holdsTenantCapabilities(member, ['users:view'])).toBe(true);
    expect(holdsTenantCapabilities(member, [COMPANY_VIEW_CAPABILITY])).toBe(true);
    expect(holdsTenantCapabilities(member, ['users:view', 'roles:view'])).toBe(false);
    expect(holdsTenantCapabilities(member, ['roles:view'])).toBe(false);
  });

  it('a member without a claim holds nothing (fail closed)', () => {
    expect(holdsTenantCapabilities({ accountRole: null, capabilities: [] }, ['users:view'])).toBe(
      false,
    );
  });
});
