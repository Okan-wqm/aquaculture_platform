import 'reflect-metadata';

import { REQUIRED_TENANT_PERMISSIONS_KEY } from '@aquaculture/backend-common/decorators';

import { TenantRoleResolver } from '../tenant-role.resolver';

/**
 * MT-HIGH-054 / RBAC-MEDIUM-001 — tenant-RBAC delegation gating invariant.
 *
 * Every GraphQL operation on TenantRoleResolver MUST carry a
 * @RequireTenantPermission decorator so the globally-registered
 * TenantPermissionGuard enforces it (SUPER_ADMIN/TENANT_ADMIN bypass; a tenant
 * user with the matching capability is delegated in; everyone else is denied).
 *
 * WHY the rewrite (RBAC-MEDIUM-001): the previous version iterated a
 * HAND-MAINTAINED list of method names — a newly-added @Query/@Mutation that was
 * forgotten in that list AND left ungated passed CI silently, falling through
 * BOTH opt-in guards to any authenticated tenant user. This version enumerates
 * the resolver's ACTUAL own methods and partitions them into gated vs ungated by
 * reflecting the permission metadata. Any ungated method that is NOT one of the
 * explicitly-listed private helpers FAILS the test, so a forgotten new operation
 * cannot ship open. (The @nestjs/graphql TypeMetadataStorage getters are empty
 * until schema build, so we cannot rely on them in a unit test — prototype
 * enumeration is the schema-build-free structural source of truth.)
 */

/**
 * The ONLY methods on the resolver that are legitimately NOT gated GraphQL
 * operations — private response-mapping helpers. Adding a method here is a
 * deliberate, reviewable act; a new *operation* must never be added here.
 */
const KNOWN_NON_OPERATIONS: ReadonlySet<string> = new Set([
  'constructor',
  'mapToGraphQL',
  'mapRoleAssignmentToGraphQL',
]);

/** Expected catalogue capability per gated operation (the mapping SSoT). */
const EXPECTED_CAPS: Record<string, string> = {
  // reads
  tenantRoles: 'roles:view',
  tenantRole: 'roles:view',
  defaultTenantRole: 'roles:view',
  permissionCategories: 'roles:view',
  getUserEffectivePermissions: 'users:view',
  // role management
  createTenantRole: 'roles:create',
  updateTenantRole: 'roles:edit',
  deleteTenantRole: 'roles:delete',
  seedTenantRoles: 'roles:create',
  // user management
  createTenantUser: 'users:invite',
  updateTenantUser: 'users:edit_permissions',
  deleteTenantUser: 'users:deactivate',
  assignUserRole: 'users:edit_permissions',
  updateUserRole: 'users:edit_permissions',
  revokeUserRole: 'users:edit_permissions',
  bulkAssignUserRole: 'users:edit_permissions',
};

function ownMethodNames(): string[] {
  return Object.getOwnPropertyNames(TenantRoleResolver.prototype).filter((name) => {
    const value: unknown = Reflect.get(TenantRoleResolver.prototype, name);
    return typeof value === 'function';
  });
}

function isGated(method: string): boolean {
  const handler = Reflect.get(TenantRoleResolver.prototype, method);
  const perms: unknown = Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, handler);
  return Array.isArray(perms) && perms.length > 0;
}

describe('TenantRoleResolver capability gating (MT-HIGH-054 / RBAC-MEDIUM-001)', () => {
  const methods = ownMethodNames();

  it('sees the resolver methods (guards against a false-green enumeration)', () => {
    // Sanity: prototype enumeration must find at least the known operations plus
    // the mapping helpers; a near-empty list means the enumeration broke.
    expect(methods.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED_CAPS).length);
  });

  it('EVERY method is either gated by @RequireTenantPermission or an explicit private helper', () => {
    const ungatedOperations = methods.filter((m) => !isGated(m) && !KNOWN_NON_OPERATIONS.has(m));
    // A new @Query/@Mutation left ungated (or forgotten in the map) lands here.
    expect(ungatedOperations).toEqual([]);
  });

  it('every gated operation maps to its expected catalogue capability', () => {
    for (const method of methods.filter(isGated)) {
      expect(EXPECTED_CAPS).toHaveProperty(method);
      const handler = Reflect.get(TenantRoleResolver.prototype, method);
      const perms = Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, handler) as string[];
      expect(perms).toContain(EXPECTED_CAPS[method]);
    }
  });

  it('has no stale entries: every mapped name and every listed non-operation is a real method', () => {
    const methodSet = new Set(methods);
    for (const mappedName of Object.keys(EXPECTED_CAPS)) {
      expect(methodSet.has(mappedName)).toBe(true);
    }
    for (const helper of KNOWN_NON_OPERATIONS) {
      expect(methodSet.has(helper)).toBe(true);
    }
  });
});
