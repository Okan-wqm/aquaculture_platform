/**
 * SSOT-H-06 regression: the canonical role hierarchy.
 *
 * The deleted hr-service RolesGuard did STRICT membership (no hierarchy), so a
 * `@Roles(TENANT_ADMIN, MODULE_MANAGER)` route DENIED a SUPER_ADMIN. These tests
 * pin the canonical hierarchy that the (now single) RolesGuard enforces, so the
 * exact prior bug cannot silently return.
 */

import { Role, ROLE_HIERARCHY, roleHasPermission } from '../roles.decorator';

describe('canonical role hierarchy (SSOT-H-06 regression)', () => {
  it('SUPER_ADMIN inherits TENANT_ADMIN — the exact route the HR fork guard denied', () => {
    expect(roleHasPermission(Role.SUPER_ADMIN, Role.TENANT_ADMIN)).toBe(true);
    expect(roleHasPermission(Role.SUPER_ADMIN, Role.MODULE_MANAGER)).toBe(true);
    expect(roleHasPermission(Role.SUPER_ADMIN, Role.MODULE_USER)).toBe(true);
  });

  it('TENANT_ADMIN inherits the module roles but NOT SUPER_ADMIN', () => {
    expect(roleHasPermission(Role.TENANT_ADMIN, Role.MODULE_MANAGER)).toBe(true);
    expect(roleHasPermission(Role.TENANT_ADMIN, Role.MODULE_USER)).toBe(true);
    expect(roleHasPermission(Role.TENANT_ADMIN, Role.SUPER_ADMIN)).toBe(false);
  });

  it('MODULE_USER (lowest) satisfies only itself', () => {
    expect(roleHasPermission(Role.MODULE_USER, Role.MODULE_USER)).toBe(true);
    expect(roleHasPermission(Role.MODULE_USER, Role.MODULE_MANAGER)).toBe(false);
    expect(roleHasPermission(Role.MODULE_USER, Role.TENANT_ADMIN)).toBe(false);
  });

  it('every Role enum member has a hierarchy entry (no missing-key silent fail)', () => {
    for (const r of Object.values(Role)) {
      expect(ROLE_HIERARCHY[r]).toBeDefined();
    }
  });
});
