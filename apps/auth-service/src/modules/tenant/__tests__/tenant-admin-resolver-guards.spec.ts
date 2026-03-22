/* eslint-disable @typescript-eslint/no-explicit-any */
import 'reflect-metadata';
import { Role } from '@platform/backend-common';

import { TenantAdminResolver } from '../resolvers/tenant-admin.resolver';

/**
 * Verify that TenantAdminResolver.myModules has proper auth guard.
 */
describe('TenantAdminResolver — Guard Decorators', () => {
  function getRolesMetadata(method: any): Role[] | undefined {
    return Reflect.getMetadata('roles', method) as Role[] | undefined;
  }

  it('myModules should require at least MODULE_USER role', () => {
    const roles = getRolesMetadata(TenantAdminResolver.prototype.myModules);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.MODULE_USER);
    expect(roles).toContain(Role.MODULE_MANAGER);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).toContain(Role.SUPER_ADMIN);
  });

  it('moduleUsers should require TenantAdminOrHigher', () => {
    const roles = getRolesMetadata(TenantAdminResolver.prototype.moduleUsers);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });
});
