import 'reflect-metadata';

import { TENANT_CAPABILITY_CATALOGUE, isTenantCapability } from '@aquaculture/shared-contracts';
import { Test } from '@nestjs/testing';

import {
  CATALOGUE_CAPABILITIES,
  entitledPermissionCategories,
} from '../../services/permission-catalogue';
import { TenantRoleService } from '../../services/tenant-role.service';
import { TenantUserManagementService } from '../../services/tenant-user-management.service';
import { TenantRoleResolver } from '../tenant-role.resolver';

/**
 * RBAC-MEDIUM-033, release R1 backend half (plan PKG-03, contract rule C1).
 *
 * The role editor stores what `permissionCategories` gives it. The query dropped each resource's
 * catalogue key and sent only its display name, so the editor saved panels keyed by names such
 * as "Company layer" and "Edge Devices", from which no `resource:action` capability can be built:
 * a `company:view` ticked in the editor never reached the JWT. The query now carries the key
 * beside the name. The R2 web reads it (C1: a field the web reads ships one release earlier).
 */
const TENANT_ID = '6d1f3a2b-4c5e-4f70-8a91-b2c3d4e5f607';

async function resolverServing(
  categories: ReturnType<typeof entitledPermissionCategories>,
): Promise<{ resolver: TenantRoleResolver; getPermissionCategories: jest.Mock }> {
  const getPermissionCategories = jest.fn().mockResolvedValue(categories);
  const moduleRef = await Test.createTestingModule({
    providers: [
      TenantRoleResolver,
      { provide: TenantRoleService, useValue: { getPermissionCategories } },
      { provide: TenantUserManagementService, useValue: {} },
    ],
  }).compile();
  return { resolver: moduleRef.get(TenantRoleResolver), getPermissionCategories };
}

describe('TenantRoleResolver.permissionCategories resource keys (RBAC-MEDIUM-033, R1)', () => {
  it('returns each resource under its catalogue key, beside its display name', async () => {
    const { resolver, getPermissionCategories } = await resolverServing(
      entitledPermissionCategories(CATALOGUE_CAPABILITIES),
    );

    const categories = await resolver.permissionCategories(TENANT_ID);

    expect(getPermissionCategories).toHaveBeenCalledWith(TENANT_ID);
    const byCategory = new Map(categories.map((category) => [category.categoryKey, category]));
    expect(byCategory.get('company')?.resources).toEqual([
      { key: 'company', name: 'Company layer', actions: ['view'] },
    ]);
    expect(byCategory.get('sensor')?.resources).toEqual([
      { key: 'edge_devices', name: 'Edge Devices', actions: ['manage_io_config'] },
    ]);
    expect(byCategory.get('admin')?.resources.map((resource) => resource.key)).toEqual(
      Object.keys(TENANT_CAPABILITY_CATALOGUE.admin.resources),
    );
    expect(byCategory.get('admin')?.resources).toContainEqual({
      key: 'users',
      name: 'Users',
      actions: ['view', 'invite', 'edit_permissions', 'deactivate'],
    });
  });

  it('offers only key:action pairs the write path accepts as capabilities', async () => {
    const { resolver } = await resolverServing(
      entitledPermissionCategories(CATALOGUE_CAPABILITIES),
    );

    const offered = (await resolver.permissionCategories(TENANT_ID)).flatMap((category) =>
      category.resources.flatMap((resource) =>
        resource.actions.map((action) => `${resource.key}:${action}`),
      ),
    );

    expect(offered.filter((capability) => !isTenantCapability(capability))).toEqual([]);
    expect(new Set(offered)).toEqual(CATALOGUE_CAPABILITIES);
  });

  it('keys the resources of an entitlement-filtered view the same way', async () => {
    const { resolver } = await resolverServing(
      entitledPermissionCategories(new Set(['company:view', 'roles:view'])),
    );

    expect(await resolver.permissionCategories(TENANT_ID)).toEqual([
      {
        categoryKey: 'company',
        name: 'Company',
        resources: [{ key: 'company', name: 'Company layer', actions: ['view'] }],
      },
      {
        categoryKey: 'admin',
        name: 'Settings & User Management',
        resources: [{ key: 'roles', name: 'Roles', actions: ['view'] }],
      },
    ]);
  });
});
