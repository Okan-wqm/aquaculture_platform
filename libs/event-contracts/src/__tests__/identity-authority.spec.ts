import {
  INVITABLE_ROLE_CODES,
  PLATFORM_ROLE_CODES,
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_HIERARCHY,
  Role,
  implicitPermissionsForRole,
  isInvitableRole,
  isPlatformRole,
  roleAtLeast,
} from '../roles';
import {
  TENANT_PERMISSION_CATEGORIES,
  TENANT_PERMISSION_CODES,
  isTenantPermissionCode,
} from '../tenant-permissions';

describe('platform identity authority', () => {
  it('publishes exactly one definition for each canonical role', () => {
    expect(Object.values(Role)).toEqual(PLATFORM_ROLE_CODES);
    expect(Object.keys(PLATFORM_ROLE_DEFINITIONS).sort()).toEqual([...PLATFORM_ROLE_CODES].sort());
    expect(PLATFORM_ROLE_CODES.map((role) => PLATFORM_ROLE_DEFINITIONS[role].code)).toEqual(
      PLATFORM_ROLE_CODES,
    );
  });

  it('keeps invitation policy inside the canonical role vocabulary', () => {
    expect(INVITABLE_ROLE_CODES).toEqual([
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ]);
    expect(INVITABLE_ROLE_CODES.every(isPlatformRole)).toBe(true);
    expect(isInvitableRole(Role.SUPER_ADMIN)).toBe(false);
  });

  it('rejects phantom application roles', () => {
    expect(isPlatformRole('ADMIN')).toBe(false);
    expect(isPlatformRole('OWNER')).toBe(false);
    expect(isPlatformRole('user')).toBe(false);
  });

  it('derives hierarchy and implicit permissions from canonical role semantics', () => {
    expect(roleAtLeast(Role.TENANT_ADMIN, Role.MODULE_MANAGER)).toBe(true);
    expect(roleAtLeast(Role.MODULE_USER, Role.MODULE_MANAGER)).toBe(false);
    expect(PLATFORM_ROLE_HIERARCHY[Role.SUPER_ADMIN]).toEqual([
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ]);
    expect(implicitPermissionsForRole(Role.SUPER_ADMIN)).toEqual(['*']);
    expect(implicitPermissionsForRole(Role.TENANT_ADMIN)).toEqual(['*']);
    expect(implicitPermissionsForRole(Role.MODULE_MANAGER)).toEqual([]);
    expect(implicitPermissionsForRole(Role.MODULE_USER)).toEqual([]);
    expect(implicitPermissionsForRole('VIEWER')).toEqual([]);
  });
});

describe('tenant permission authority', () => {
  it('publishes a unique, sorted catalogue backed by the validator', () => {
    expect(TENANT_PERMISSION_CODES).toEqual([...TENANT_PERMISSION_CODES].sort());
    expect(new Set(TENANT_PERMISSION_CODES).size).toBe(TENANT_PERMISSION_CODES.length);
    expect(TENANT_PERMISSION_CODES.every(isTenantPermissionCode)).toBe(true);
  });

  it('deep-freezes every public catalogue projection', () => {
    expect(Object.isFrozen(TENANT_PERMISSION_CATEGORIES)).toBe(true);
    expect(Object.isFrozen(TENANT_PERMISSION_CATEGORIES.operations)).toBe(true);
    expect(Object.isFrozen(TENANT_PERMISSION_CATEGORIES.operations.resources.edge)).toBe(true);
    expect(
      Object.isFrozen(TENANT_PERMISSION_CATEGORIES.operations.resources.edge.actions),
    ).toBe(true);
    expect(Object.isFrozen(TENANT_PERMISSION_CODES)).toBe(true);
    expect(
      Reflect.set(TENANT_PERMISSION_CATEGORIES.operations.resources.edge, 'name', 'mutated'),
    ).toBe(false);
  });

  it('includes every capability enforced by the edge I/O resolvers', () => {
    expect(isTenantPermissionCode('edge:manage-io-config')).toBe(true);
  });

  it('rejects capabilities outside the closed catalogue', () => {
    expect(isTenantPermissionCode('roles:super-admin')).toBe(false);
    expect(isTenantPermissionCode('edge:write')).toBe(false);
  });
});
