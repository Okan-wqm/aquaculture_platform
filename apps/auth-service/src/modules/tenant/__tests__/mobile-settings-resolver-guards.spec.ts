/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import { Role } from '@platform/backend-common';

import { MobileSettingsResolver } from '../resolvers/mobile-settings.resolver';

/**
 * Verify that MobileSettingsResolver methods have the correct auth guard decorators.
 *
 * - getMobileUserSettings, getMobileUsersSettings, updateMobileUserSettings, bulkUpdateMobileSettings
 *   must require @TenantAdminOrHigher()
 * - getMyMobileSettings must require at minimum @Roles(Role.MODULE_USER)
 */
describe('MobileSettingsResolver — Guard Decorators', () => {
  /**
   * Helper: extract the 'roles' metadata key from a method descriptor.
   * Both @Roles() and @TenantAdminOrHigher() set the same 'roles' metadata.
   */
  function getRolesMetadata(method: any): Role[] | undefined {
    return Reflect.getMetadata('roles', method) as Role[] | undefined;
  }

  it('getMobileUserSettings should require TenantAdminOrHigher', () => {
    const roles = getRolesMetadata(MobileSettingsResolver.prototype.getMobileUserSettings);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    // Should NOT contain lower roles
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('getMobileUsersSettings should require TenantAdminOrHigher', () => {
    const roles = getRolesMetadata(MobileSettingsResolver.prototype.getMobileUsersSettings);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('updateMobileUserSettings should require TenantAdminOrHigher', () => {
    const roles = getRolesMetadata(MobileSettingsResolver.prototype.updateMobileUserSettings);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('bulkUpdateMobileSettings should require TenantAdminOrHigher', () => {
    const roles = getRolesMetadata(MobileSettingsResolver.prototype.bulkUpdateMobileSettings);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('getMyMobileSettings should allow MODULE_USER (minimum role)', () => {
    const roles = getRolesMetadata(MobileSettingsResolver.prototype.getMyMobileSettings);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.MODULE_USER);
  });
});
