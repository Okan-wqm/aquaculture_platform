import 'reflect-metadata';
import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';

import { MobileSettingsResolver } from '../resolvers/mobile-settings.resolver';

/**
 * Verify that MobileSettingsResolver methods have the correct auth guard decorators.
 *
 * NestJS SetMetadata stores metadata on the method function itself (not on
 * target + propertyKey). To read it type-safely we look up the property
 * descriptor value and pass it as the target to Reflect.getMetadata.
 *
 * - getMobileUserSettings, getMobileUsersSettings, updateMobileUserSettings, bulkUpdateMobileSettings
 *   must require @TenantAdminOrHigher()
 * - getMyMobileSettings must require at minimum @Roles(Role.MODULE_USER)
 */
describe('MobileSettingsResolver — Guard Decorators', () => {
  /**
   * Type-safe helper: extract the 'roles' metadata from a resolver method.
   *
   * NestJS SetMetadata attaches metadata to the method descriptor value (the
   * function object), so we retrieve the descriptor and pass descriptor.value
   * as the Reflect.getMetadata target. This avoids using `any`.
   */
  function getMethodRoles(prototype: object, methodName: string): Role[] | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor?.value) return undefined;
    return Reflect.getMetadata(ROLES_KEY, descriptor.value as object) as Role[] | undefined;
  }

  it('getMobileUserSettings should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(MobileSettingsResolver.prototype, 'getMobileUserSettings');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    // Should NOT contain lower roles
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('getMobileUsersSettings should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(MobileSettingsResolver.prototype, 'getMobileUsersSettings');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('updateMobileUserSettings should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(MobileSettingsResolver.prototype, 'updateMobileUserSettings');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('bulkUpdateMobileSettings should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(MobileSettingsResolver.prototype, 'bulkUpdateMobileSettings');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('getMyMobileSettings should allow MODULE_USER (minimum role)', () => {
    const roles = getMethodRoles(MobileSettingsResolver.prototype, 'getMyMobileSettings');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.MODULE_USER);
  });
});
