import 'reflect-metadata';

import { REQUIRED_TENANT_PERMISSIONS_KEY } from '@aquaculture/backend-common/decorators';

import { TenantRoleResolver } from '../tenant-role.resolver';

/**
 * MT-HIGH-054 — tenant-RBAC delegation gating invariant.
 *
 * Every GraphQL operation on TenantRoleResolver MUST carry a
 * @RequireTenantPermission decorator so the globally-registered
 * TenantPermissionGuard enforces it (SUPER_ADMIN/TENANT_ADMIN bypass; a tenant
 * user with the matching capability is delegated in; everyone else is denied).
 *
 * This test is the structural guarantee against the one dangerous failure mode
 * of the @Roles→@RequireTenantPermission migration: a method that loses its
 * @Roles gate but is NOT given a @RequireTenantPermission would fall through
 * BOTH opt-in guards and become open to any authenticated tenant user. If a new
 * operation is added without a capability, or a mapping is changed, this fails.
 */
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

describe('TenantRoleResolver capability gating (MT-HIGH-054)', () => {
  it('gates EVERY operation with @RequireTenantPermission (no ungated method)', () => {
    for (const method of Object.keys(EXPECTED_CAPS)) {
      const handler = Reflect.get(TenantRoleResolver.prototype, method);
      expect(typeof handler).toBe('function');

      const perms: unknown = Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, handler);
      expect(Array.isArray(perms)).toBe(true);
      expect((perms as string[]).length).toBeGreaterThan(0);
    }
  });

  it('maps each operation to its catalogue capability', () => {
    for (const [method, capability] of Object.entries(EXPECTED_CAPS)) {
      const handler = Reflect.get(TenantRoleResolver.prototype, method);
      const perms = Reflect.getMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, handler) as string[];
      expect(perms).toContain(capability);
    }
  });
});
