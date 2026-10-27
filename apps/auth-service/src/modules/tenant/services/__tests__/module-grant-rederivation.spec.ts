import { Role } from '@aquaculture/backend-common/decorators';
import type { ModuleRole } from '@aquaculture/shared-contracts';
import { stub, stubMember } from '@aquaculture/testing';
import type { EntityManager, Repository } from 'typeorm';

import { UserModuleAssignment } from '../../../authentication/entities/user-module-assignment.entity';
import { Module } from '../../../system-module/entities/module.entity';
import { TenantModule } from '../../entities/tenant-module.entity';
import { rederiveModuleGrantRoles } from '../module-grant-rederivation';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const FARM = '10000000-0000-4000-8000-000000000001';
const HR = '10000000-0000-4000-8000-000000000002';
const SENSOR = '10000000-0000-4000-8000-000000000003';

function grant(
  id: string,
  moduleId: string,
  code: string,
  role: ModuleRole | null,
  isPrimaryManager = false,
): UserModuleAssignment {
  return Object.assign(new UserModuleAssignment(), {
    id,
    userId: MEMBER,
    moduleId,
    tenantId: TENANT,
    isPrimaryManager,
    isActive: true,
    role,
    module: Object.assign(new Module(), { id: moduleId, code }),
  });
}

function makeManager(
  rows: readonly UserModuleAssignment[],
  designatedModuleIds: readonly string[],
): {
  manager: EntityManager;
  query: jest.Mock;
  assignments: { find: jest.Mock; update: jest.Mock };
  tenantModules: { find: jest.Mock };
} {
  const query = jest.fn().mockResolvedValue([]);
  const assignments = {
    find: jest.fn().mockResolvedValue(rows),
    update: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
  };
  const tenantModules = {
    find: jest
      .fn()
      .mockResolvedValue(
        designatedModuleIds.map((moduleId) => Object.assign(new TenantModule(), { moduleId })),
      ),
  };
  const manager = stub<EntityManager>({
    query,
    getRepository: stubMember<EntityManager['getRepository']>((entity: unknown) => {
      if (entity === UserModuleAssignment)
        return stub<Repository<UserModuleAssignment>>(assignments);
      if (entity === TenantModule) return stub<Repository<TenantModule>>(tenantModules);
      throw new Error('getRepository: unexpected entity');
    }),
  });
  return { manager, query, assignments, tenantModules };
}

/**
 * RBAC-HIGH-027: a grant's role follows its inputs. After users.role, tenant_modules.managerId
 * or isPrimaryManager changed, the member's grants are re-derived by the one rule
 * (assignment-module-role.ts) and only the roles that differ are written.
 */
describe('rederiveModuleGrantRoles (RBAC-HIGH-027)', () => {
  it("reads the member's grants and designations in the tenant and writes only the roles that differ", async () => {
    const { manager, query, assignments, tenantModules } = makeManager(
      [
        grant('uma-farm', FARM, 'farm', 'MODULE_USER'),
        grant('uma-hr', HR, 'hr', 'MODULE_USER'),
        grant('uma-sensor', SENSOR, 'sensor', 'MODULE_MANAGER'),
      ],
      [FARM],
    );

    const changes = await rederiveModuleGrantRoles(manager, {
      tenantId: TENANT,
      userId: MEMBER,
      role: Role.MODULE_USER,
    });

    // RLS: the member's tenant is bound before the first read (bindTenantRlsContext).
    expect(query).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', [
      'app.current_tenant',
      TENANT,
    ]);
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(
      assignments.find.mock.invocationCallOrder[0]!,
    );
    expect(assignments.find).toHaveBeenCalledWith({
      where: { userId: MEMBER, tenantId: TENANT },
      relations: { module: true },
    });
    expect(tenantModules.find).toHaveBeenCalledWith({
      select: { moduleId: true },
      where: { managerId: MEMBER, tenantId: TENANT },
    });
    expect(changes).toEqual([
      { moduleId: FARM, from: 'MODULE_USER', to: 'MODULE_MANAGER' },
      { moduleId: SENSOR, from: 'MODULE_MANAGER', to: 'MODULE_USER' },
    ]);
    expect(assignments.update.mock.calls).toEqual([
      [{ id: 'uma-farm', tenantId: TENANT }, { role: 'MODULE_MANAGER' }],
      [{ id: 'uma-sensor', tenantId: TENANT }, { role: 'MODULE_USER' }],
    ]);
  });

  it('fills a row an R0 container wrote without a role, and keeps an hr primary manager managing hr', async () => {
    const { manager, assignments } = makeManager(
      [grant('uma-farm', FARM, 'farm', null), grant('uma-hr', HR, 'hr', 'MODULE_USER', true)],
      [],
    );

    const changes = await rederiveModuleGrantRoles(manager, {
      tenantId: TENANT,
      userId: MEMBER,
      role: Role.MODULE_MANAGER,
    });

    expect(changes).toEqual([
      { moduleId: FARM, from: null, to: 'MODULE_MANAGER' },
      { moduleId: HR, from: 'MODULE_USER', to: 'MODULE_MANAGER' },
    ]);
    expect(assignments.update).toHaveBeenCalledTimes(2);
  });

  it('never derives an hr manager grant from users.role or a designation (D6)', async () => {
    const { manager, assignments } = makeManager([grant('uma-hr', HR, 'hr', 'MODULE_USER')], [HR]);

    const changes = await rederiveModuleGrantRoles(manager, {
      tenantId: TENANT,
      userId: MEMBER,
      role: Role.MODULE_MANAGER,
    });

    expect(changes).toEqual([]);
    expect(assignments.update).not.toHaveBeenCalled();
  });

  it('reads no designation for a member without grants', async () => {
    const { manager, tenantModules } = makeManager([], [FARM]);

    await expect(
      rederiveModuleGrantRoles(manager, {
        tenantId: TENANT,
        userId: MEMBER,
        role: Role.MODULE_USER,
      }),
    ).resolves.toEqual([]);
    expect(tenantModules.find).not.toHaveBeenCalled();
  });
});
