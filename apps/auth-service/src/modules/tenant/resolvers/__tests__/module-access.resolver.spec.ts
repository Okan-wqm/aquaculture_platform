import 'reflect-metadata';

import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';
import { BadRequestException } from '@nestjs/common';

import type { AuditLogService } from '../../../../audit/audit-log.service';
import { ModuleAccessGrants } from '../../../authentication/dto/module-access.dto';
import type { ModuleAccessService } from '../../services/module-access.service';
import type { TenantProvisioningCommandService } from '../../services/tenant-provisioning-command.service';
import type { TenantService } from '../../services/tenant.service';
import { ModuleAccessResolver } from '../module-access.resolver';
import { TenantResolver } from '../tenant.resolver';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = '00000000-0000-4000-8000-0000000000ad';
const MEMBER = '22222222-2222-4222-8222-222222222222';

function rolesOf(prototype: object, method: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (descriptor === undefined || typeof descriptor.value !== 'function') return undefined;
  return Reflect.getMetadata(ROLES_KEY, descriptor.value);
}

/**
 * The admin path of module access (PKG-06): every operation is a tenant administrator's, in the
 * caller's own tenant (from the verified claim, never an argument), and Assign / Remove Manager
 * name the module by its code (the module id of the release-R2 web is still taken, one of the
 * two exactly).
 */
describe('ModuleAccessResolver', () => {
  it.each(['setUserModuleAccess', 'userModuleAccess', 'modulePrimaryManagers'])(
    '%s requires TenantAdminOrHigher',
    (method) => {
      expect(rolesOf(ModuleAccessResolver.prototype, method)).toEqual([
        Role.SUPER_ADMIN,
        Role.TENANT_ADMIN,
      ]);
    },
  );

  it("sets the member's module roles in the caller's tenant, as the caller", async () => {
    const setUserModuleAccess = jest
      .fn()
      .mockResolvedValue({ userId: MEMBER, moduleAccess: { farm: 'MODULE_MANAGER' } });
    const resolver = new ModuleAccessResolver(
      collaborator<ModuleAccessService>({ setUserModuleAccess }, 'ModuleAccessService'),
    );
    const moduleAccess = Object.assign(new ModuleAccessGrants(), {
      farm: 'MODULE_MANAGER',
      hr: null,
      sensor: null,
      hydroponics: null,
    });

    const result = await resolver.setUserModuleAccess(ACTOR, TENANT, {
      userId: MEMBER,
      moduleAccess,
    });

    expect(setUserModuleAccess).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: ACTOR },
      {
        userId: MEMBER,
        moduleAccess: { farm: 'MODULE_MANAGER', hr: null, sensor: null, hydroponics: null },
      },
    );
    expect(result).toEqual({
      userId: MEMBER,
      moduleAccess: Object.assign(new ModuleAccessGrants(), {
        farm: 'MODULE_MANAGER',
        hr: null,
        sensor: null,
        hydroponics: null,
      }),
    });
  });
});

describe('TenantResolver Assign / Remove Manager (by module code)', () => {
  function resolverWith(moduleAccess: Partial<ModuleAccessService>): TenantResolver {
    return new TenantResolver(
      collaborator<TenantService>({}, 'TenantService'),
      collaborator<AuditLogService>({}, 'AuditLogService'),
      collaborator<TenantProvisioningCommandService>({}, 'TenantProvisioningCommandService'),
      collaborator<ModuleAccessService>(moduleAccess, 'ModuleAccessService'),
    );
  }

  it('assigns by module code, as the caller, in the caller tenant', async () => {
    const assignModuleManager = jest.fn().mockResolvedValue({ id: 'tm-farm' });
    const resolver = resolverWith({ assignModuleManager });

    await resolver.assignModuleManager({ moduleCode: 'farm', userId: MEMBER }, TENANT, ACTOR);

    expect(assignModuleManager).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: ACTOR },
      { module: { moduleCode: 'farm' }, userId: MEMBER },
    );
  });

  it('still takes the module id the release-R2 web sends', async () => {
    const assignModuleManager = jest.fn().mockResolvedValue({ id: 'tm-farm' });
    const removeModuleManager = jest.fn().mockResolvedValue({ id: 'tm-farm' });
    const resolver = resolverWith({ assignModuleManager, removeModuleManager });

    await resolver.assignModuleManager({ moduleId: 'm-1', userId: MEMBER }, TENANT, ACTOR);
    await resolver.removeModuleManager(TENANT, ACTOR, 'm-1', undefined);

    expect(assignModuleManager).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: ACTOR },
      { module: { moduleId: 'm-1' }, userId: MEMBER },
    );
    expect(removeModuleManager).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: ACTOR },
      { module: { moduleId: 'm-1' } },
    );
  });

  it('removes by module code', async () => {
    const removeModuleManager = jest.fn().mockResolvedValue({ id: 'tm-hr' });
    const resolver = resolverWith({ removeModuleManager });

    await resolver.removeModuleManager(TENANT, ACTOR, undefined, 'hr');

    expect(removeModuleManager).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: ACTOR },
      { module: { moduleCode: 'hr' } },
    );
  });

  it('refuses both a module code and a module id, and neither', async () => {
    const resolver = resolverWith({});

    await expect(
      resolver.assignModuleManager(
        { moduleCode: 'farm', moduleId: 'm-1', userId: MEMBER },
        TENANT,
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(resolver.assignModuleManager({ userId: MEMBER }, TENANT, ACTOR)).rejects.toThrow(
      BadRequestException,
    );
    await expect(resolver.removeModuleManager(TENANT, ACTOR, undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
  });
});
