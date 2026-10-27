import {
  TENANT_CAPABILITIES,
  TENANT_CAPABILITY_CATALOGUE,
  type TenantCapability,
} from '@aquaculture/shared-contracts';
import { Role } from '@aquaculture/backend-common/decorators';

import {
  ALL_TENANT_CAPABILITIES,
  RoleTemplateService,
  type RoleTemplate,
} from '../services/role-template.service';

/**
 * RBAC-HIGH-025: admin-api published a capability list of its own (`farms:view`, `users:create`,
 * `billing:manage`, …) that neither the catalogue nor any guard knew, and gave each platform role
 * a list of them. The reference endpoints now read the one catalogue
 * (`@aquaculture/shared-contracts` TENANT_CAPABILITY_CATALOGUE), and a role template can name
 * only a catalogue capability or the account roles' "every capability".
 *
 * What a role holds follows ADR-051 §1: an account role (SUPER_ADMIN, TENANT_ADMIN) holds every
 * tenant capability; a module role holds none by itself — a member holds exactly the
 * capabilities of the tenant role assigned to them.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('RoleTemplateService reads the one capability catalogue (RBAC-HIGH-025)', () => {
  const service = new RoleTemplateService();

  it('publishes exactly the catalogue capabilities, in catalogue order', () => {
    expect(service.getAllPermissions().map((permission) => permission.code)).toEqual([
      ...TENANT_CAPABILITIES,
    ]);
  });

  it('groups them by the catalogue category name', () => {
    const grouped = service.getPermissionsByCategory();
    expect(Object.keys(grouped)).toEqual(
      Object.values(TENANT_CAPABILITY_CATALOGUE).map((category) => category.name),
    );
    expect(grouped['Company']!.map((permission) => permission.code)).toEqual(['company:view']);
  });

  it('a template names only a catalogue capability or every capability, by type', () => {
    const typed: Equals<
      RoleTemplate['permissions'][number],
      TenantCapability | typeof ALL_TENANT_CAPABILITIES
    > = true;
    expect(typed).toBe(true);
    for (const template of service.getAllRoleTemplates()) {
      for (const permission of template.permissions) {
        expect({ role: template.code, permission, known: isKnown(permission) }).toEqual({
          role: template.code,
          permission,
          known: true,
        });
      }
    }
  });

  it.each([Role.SUPER_ADMIN, Role.TENANT_ADMIN])('%s holds every capability', (role) => {
    expect(service.getRolePermissions(role)).toEqual([...TENANT_CAPABILITIES]);
    expect(service.hasPermission(role, 'company:view')).toBe(true);
    expect(service.hasPermission(role, 'edge_devices:manage_io_config')).toBe(true);
  });

  it.each([Role.MODULE_MANAGER, Role.MODULE_USER])(
    '%s holds no capability by role alone (it comes from the tenant role)',
    (role) => {
      expect(service.getRolePermissions(role)).toEqual([]);
      expect(service.hasPermission(role, 'users:view')).toBe(false);
    },
  );

  it('names no key the catalogue removed or never had', () => {
    const codes = service.getAllPermissions().map((permission) => permission.code);
    for (const stale of ['farms:view', 'users:create', 'billing:manage', 'dashboard:view']) {
      expect(codes).not.toContain(stale);
    }
  });
});

function isKnown(permission: string): boolean {
  return (
    permission === ALL_TENANT_CAPABILITIES ||
    TENANT_CAPABILITIES.some((capability) => capability === permission)
  );
}
