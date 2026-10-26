import {
  ACCOUNT_ROLES,
  MODULE_ROLES,
  PLATFORM_ROLE,
  PLATFORM_ROLE_HIERARCHY,
  PLATFORM_ROLE_KIND,
  PLATFORM_ROLES_BY_PRIVILEGE,
  accountRoleOf,
  highestPlatformRole,
  isAccountRole,
  isModuleRole,
  isPlatformRole,
  platformRoleSatisfies,
  type AccountRole,
  type ModuleRole,
  type PlatformRole,
} from '../platform-roles';

/**
 * The platform roles and their one hierarchy (RBAC-MEDIUM-024; ADR-051 §1). The backend
 * `RolesGuard`, the web `hasRoleOrHigher`, the mobile role floors and `decideAccess` all read
 * this declaration; `tests/invariants/role-hierarchy-single-owner.spec.ts` fails any copy.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('platform roles (the one hierarchy)', () => {
  it('orders the four platform roles from most to least privileged', () => {
    expect(PLATFORM_ROLES_BY_PRIVILEGE).toEqual([
      'SUPER_ADMIN',
      'TENANT_ADMIN',
      'MODULE_MANAGER',
      'MODULE_USER',
    ]);
    expect(Object.values(PLATFORM_ROLE)).toEqual(PLATFORM_ROLES_BY_PRIVILEGE);
  });

  it('derives the inheritance map from the order: each role inherits every role below it', () => {
    expect(PLATFORM_ROLE_HIERARCHY).toEqual({
      SUPER_ADMIN: ['TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER'],
      TENANT_ADMIN: ['MODULE_MANAGER', 'MODULE_USER'],
      MODULE_MANAGER: ['MODULE_USER'],
      MODULE_USER: [],
    });
  });

  it.each(
    PLATFORM_ROLES_BY_PRIVILEGE.flatMap((held, heldRank) =>
      PLATFORM_ROLES_BY_PRIVILEGE.map(
        (required, requiredRank) => [held, required, heldRank <= requiredRank] as const,
      ),
    ),
  )('%s satisfies %s: %s', (held, required, expected) => {
    expect(platformRoleSatisfies(held, required)).toBe(expected);
  });

  it('fails closed on a role string from a claim that is no platform role', () => {
    // A token claim can carry any string whatever the static type says.
    const unknownRole = 'SOMETHING_ELSE' as PlatformRole;
    for (const role of PLATFORM_ROLES_BY_PRIVILEGE) {
      expect(platformRoleSatisfies(unknownRole, role)).toBe(false);
      expect(platformRoleSatisfies(role, unknownRole)).toBe(false);
    }
    expect(platformRoleSatisfies(unknownRole, unknownRole)).toBe(false);
  });

  it('splits the roles into account roles and module roles (ADR-051 §1)', () => {
    expect(ACCOUNT_ROLES).toEqual(['SUPER_ADMIN', 'TENANT_ADMIN']);
    expect(MODULE_ROLES).toEqual(['MODULE_MANAGER', 'MODULE_USER']);
    expect(PLATFORM_ROLE_KIND).toEqual({
      SUPER_ADMIN: 'account',
      TENANT_ADMIN: 'account',
      MODULE_MANAGER: 'module',
      MODULE_USER: 'module',
    });
    const kinds: [
      Equals<AccountRole, 'SUPER_ADMIN' | 'TENANT_ADMIN'>,
      Equals<ModuleRole, 'MODULE_MANAGER' | 'MODULE_USER'>,
    ] = [true, true];
    expect(kinds).toEqual([true, true]);
  });

  it('narrows unknown values exactly, without case folding (fail closed)', () => {
    expect(isPlatformRole('TENANT_ADMIN')).toBe(true);
    expect(isPlatformRole('tenant_admin')).toBe(false);
    expect(isPlatformRole('VIEWER')).toBe(false);
    expect(isPlatformRole(undefined)).toBe(false);
    expect(isAccountRole('TENANT_ADMIN')).toBe(true);
    expect(isAccountRole('MODULE_MANAGER')).toBe(false);
    expect(isModuleRole('MODULE_MANAGER')).toBe(true);
    expect(isModuleRole('SUPER_ADMIN')).toBe(false);
  });

  it('reads the most privileged platform role among the strings an identity carries', () => {
    expect(highestPlatformRole(['MODULE_USER', 'MODULE_MANAGER'])).toBe('MODULE_MANAGER');
    expect(highestPlatformRole(['OWNER', 'MODULE_USER', 'SUPER_ADMIN'])).toBe('SUPER_ADMIN');
    expect(highestPlatformRole(['module_user', 'VIEWER'])).toBeNull();
    expect(highestPlatformRole([])).toBeNull();
  });

  it('reads the account role from the roles a verified identity carries: the highest, or none', () => {
    expect(accountRoleOf(['MODULE_USER', 'TENANT_ADMIN'])).toBe('TENANT_ADMIN');
    expect(accountRoleOf(['TENANT_ADMIN', 'SUPER_ADMIN'])).toBe('SUPER_ADMIN');
    // The legacy global MODULE_MANAGER is no account role: it carries no account power.
    expect(accountRoleOf(['MODULE_MANAGER'])).toBeNull();
    expect(accountRoleOf(['tenant_admin', 'OWNER'])).toBeNull();
    expect(accountRoleOf([])).toBeNull();
  });

  it.each([
    ['a string containing a role name', 'NOT_A_SUPER_ADMIN_ROLE'],
    ['a bare role string', 'SUPER_ADMIN'],
    ['an object', { 0: 'SUPER_ADMIN', length: 1 }],
    ['null', null],
    ['a role inside an entry', ['NOT_A_TENANT_ADMIN_ROLE', ['SUPER_ADMIN']]],
  ])('holds no role when the roles claim is %s (exact match on an array only)', (_name, roles) => {
    expect(highestPlatformRole(roles)).toBeNull();
    expect(accountRoleOf(roles)).toBeNull();
  });

  it('is frozen at every level', () => {
    for (const value of [
      PLATFORM_ROLES_BY_PRIVILEGE,
      PLATFORM_ROLE,
      PLATFORM_ROLE_KIND,
      ACCOUNT_ROLES,
      MODULE_ROLES,
      PLATFORM_ROLE_HIERARCHY,
      ...Object.values(PLATFORM_ROLE_HIERARCHY),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    const role: PlatformRole = PLATFORM_ROLE.MODULE_USER;
    expect(role).toBe('MODULE_USER');
  });
});
