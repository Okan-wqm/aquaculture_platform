import { describe, it, expect } from 'vitest';
import {
  hasResourcePermission,
  hasTenantPanelAccess,
} from '../tenant-capabilities';

/**
 * Tenant-RBAC capability SSoT (FE). Must be strictly fail-closed for non-admins
 * and must bypass SUPER_ADMIN / TENANT_ADMIN, mirroring the backend guard.
 */
describe('tenant-capabilities (FE capability SSoT)', () => {
  describe('hasResourcePermission', () => {
    it('bypasses SUPER_ADMIN and TENANT_ADMIN regardless of claim', () => {
      expect(hasResourcePermission({ role: 'SUPER_ADMIN' }, 'roles:create')).toBe(true);
      expect(hasResourcePermission({ role: 'TENANT_ADMIN' }, 'anything:at-all')).toBe(true);
    });

    it('grants a non-admin only their explicitly held capability', () => {
      const user = { role: 'MODULE_USER', resourcePermissions: ['users:view', 'users:invite'] };
      expect(hasResourcePermission(user, 'users:invite')).toBe(true);
      expect(hasResourcePermission(user, 'roles:delete')).toBe(false);
    });

    it('fails closed for null user / missing claim', () => {
      expect(hasResourcePermission(null, 'users:view')).toBe(false);
      expect(hasResourcePermission(undefined, 'users:view')).toBe(false);
      expect(hasResourcePermission({ role: 'MODULE_USER' }, 'users:view')).toBe(false);
    });
  });

  describe('hasTenantPanelAccess', () => {
    it('admits global tenant admins', () => {
      expect(hasTenantPanelAccess({ role: 'TENANT_ADMIN' })).toBe(true);
      expect(hasTenantPanelAccess({ role: 'SUPER_ADMIN' })).toBe(true);
    });

    it('admits a delegate holding any delegatable panel capability', () => {
      expect(
        hasTenantPanelAccess({ role: 'MODULE_USER', resourcePermissions: ['roles:view'] }),
      ).toBe(true);
      expect(
        hasTenantPanelAccess({ role: 'MODULE_MANAGER', resourcePermissions: ['users:view'] }),
      ).toBe(true);
    });

    it('denies a non-admin with only non-panel capabilities', () => {
      expect(
        hasTenantPanelAccess({ role: 'MODULE_USER', resourcePermissions: ['feeding:record'] }),
      ).toBe(false);
      expect(hasTenantPanelAccess({ role: 'MODULE_USER' })).toBe(false);
      expect(hasTenantPanelAccess(null)).toBe(false);
    });
  });
});
