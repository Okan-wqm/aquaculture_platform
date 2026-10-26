import {
  COMPANY_VIEW_CAPABILITY,
  TENANT_CAPABILITIES,
  TENANT_CAPABILITY_CATALOGUE,
  holdsTenantCapabilities,
  isTenantCapability,
  type TenantCapability,
} from '../tenant-capabilities';

/**
 * The tenant capability vocabulary (RBAC-MEDIUM-024; ADR-051 §1 `account(capability)`): the
 * catalogue the role editor, the token mint and the write-time grant authority read, and the one
 * capability check — the account-role bypass included — that the backend
 * `hasAllResourcePermissions`, the web `hasResourcePermission` and `decideAccess` share.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Includes<U, T> = [T] extends [U] ? true : false;

describe('tenant capability catalogue', () => {
  it('keeps the categories auth-service served before the move, in order', () => {
    expect(Object.keys(TENANT_CAPABILITY_CATALOGUE)).toEqual([
      'farm',
      'batch',
      'operations',
      'hr',
      'reports',
      'admin',
      'messaging',
      'ai',
      'ai_specialists',
    ]);
    expect(TENANT_CAPABILITY_CATALOGUE.hr.resources.hr_finance).toEqual({
      name: 'HR Finance',
      actions: ['view_salary'],
    });
    expect(TENANT_CAPABILITY_CATALOGUE.ai_specialists.resources.ai_specialties.actions).toEqual([
      'farm',
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
    expect(TENANT_CAPABILITIES).toContain('users:view');
    expect(TENANT_CAPABILITIES).toContain('hr_finance:view_salary');
  });

  it('narrows a string to a catalogue capability only when the catalogue declares it', () => {
    expect(isTenantCapability('roles:edit')).toBe(true);
    expect(isTenantCapability('roles:fly')).toBe(false);
    expect(isTenantCapability('settings')).toBe(false);
    const typed: [
      Includes<TenantCapability, 'users:view'>,
      Includes<TenantCapability, 'batches:merge'>,
      Includes<TenantCapability, 'users:fly'>,
    ] = [true, true, false];
    expect(typed).toEqual([true, true, false]);
  });

  it('names the Company read capability (PKG-03 adds it to the catalogue)', () => {
    const literal: Equals<typeof COMPANY_VIEW_CAPABILITY, 'company:view'> = true;
    expect(literal).toBe(true);
    expect(COMPANY_VIEW_CAPABILITY).toBe('company:view');
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
