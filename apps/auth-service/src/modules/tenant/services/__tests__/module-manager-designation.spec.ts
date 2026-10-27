import { Role } from '@aquaculture/backend-common/decorators';
import type { ModuleRole } from '@aquaculture/shared-contracts';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import type { RefreshToken } from '../../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../../authentication/entities/user-module-assignment.entity';
import { User } from '../../../authentication/entities/user.entity';
import { readModuleAccess } from '../../../authentication/services/module-access-reader';
import { Module } from '../../../system-module/entities/module.entity';
import { TenantModule } from '../../entities/tenant-module.entity';
import type { Tenant } from '../../entities/tenant.entity';
import { DESIGNATED_MANAGER_ROW_NOTE } from '../module-manager-designation';
import { TenantService } from '../tenant.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '00000000-0000-4000-8000-0000000000ad';
/** The designee; its id sorts after PREVIOUS so the lock order is observable. */
const DESIGNEE = '22222222-2222-4222-8222-222222222222';
const PREVIOUS = '11111111-1111-4111-8111-111111111111';

const MODULE_ID = {
  farm: '10000000-0000-4000-8000-000000000001',
  hr: '10000000-0000-4000-8000-000000000002',
  sensor: '10000000-0000-4000-8000-000000000003',
  alert: '10000000-0000-4000-8000-000000000004',
} as const;
type Code = keyof typeof MODULE_ID;
const CODES: readonly Code[] = ['farm', 'hr', 'sensor', 'alert'];
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Where = Readonly<Record<string, unknown>>;

function matches(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => Reflect.get(row, key) === value);
}

interface GrantSeed {
  readonly userId: string;
  readonly code: Code;
  readonly role: ModuleRole;
  readonly isPrimaryManager?: boolean;
  readonly isActive?: boolean;
}

interface World {
  readonly service: TenantService;
  readonly users: Map<string, User>;
  /** The tenant's modules, by module id. */
  readonly tenantModules: Map<string, TenantModule>;
  readonly grants: UserModuleAssignment[];
  /** Every RLS binding (`rls:<tenant>`) and row lock taken, in order. */
  readonly locks: string[];
  readonly transactions: { count: number };
  grantOf(userId: string, code: Code): UserModuleAssignment | undefined;
  managerOf(code: Code): string | null | undefined;
}

/**
 * TenantService over an in-memory auth store reachable only through the transaction's manager:
 * the injected repositories are bare identities that throw on any direct call, so every read
 * and write the spec observes happened inside `dataSource.transaction`. Reads hand back copies,
 * as TypeORM does, so a role only changes when the code under test writes it.
 */
function makeWorld(seed: {
  readonly users: ReadonlyArray<{
    readonly id: string;
    readonly role: Role;
    readonly tenantId?: string;
  }>;
  readonly managers?: Partial<Record<Code, string>>;
  readonly grants?: readonly GrantSeed[];
}): World {
  const locks: string[] = [];
  const transactions = { count: 0 };
  const users = new Map(
    seed.users.map((user) => [
      user.id,
      Object.assign(new User(), {
        id: user.id,
        role: user.role,
        tenantId: user.tenantId ?? TENANT,
      }),
    ]),
  );
  const modules = new Map<string, Module>(
    CODES.map((code) => [
      MODULE_ID[code],
      Object.assign(new Module(), { id: MODULE_ID[code], code, name: code }),
    ]),
  );
  const tenantModules = new Map<string, TenantModule>(
    CODES.map((code) => [
      MODULE_ID[code],
      Object.assign(new TenantModule(), {
        id: `tm-${code}`,
        tenantId: TENANT,
        moduleId: MODULE_ID[code],
        isEnabled: true,
        managerId: seed.managers?.[code] ?? null,
      }),
    ]),
  );
  const grants: UserModuleAssignment[] = (seed.grants ?? []).map((grant, index) =>
    Object.assign(new UserModuleAssignment(), {
      id: `uma-${index}`,
      userId: grant.userId,
      moduleId: MODULE_ID[grant.code],
      tenantId: TENANT,
      isPrimaryManager: grant.isPrimaryManager ?? false,
      isActive: grant.isActive ?? true,
      role: grant.role,
      assignedBy: ADMIN,
    }),
  );

  const userTable = stub<Repository<User>>({
    findOne: stubMember<Repository<User>['findOne']>(
      (options: { where: Where; lock?: unknown }) => {
        if (options.lock !== undefined) locks.push(`user:${String(options.where.id)}`);
        const found = [...users.values()].find((user) => matches(user, options.where));
        return Promise.resolve(found ?? null);
      },
    ),
    save: stubMember<Repository<User>['save']>((user: User) => Promise.resolve(user)),
  });
  const tenantModuleTable = stub<Repository<TenantModule>>({
    findOne: stubMember<Repository<TenantModule>['findOne']>(
      (options: { where: Where; lock?: unknown }) => {
        if (options.lock !== undefined)
          locks.push(`tenant_module:${String(options.where.moduleId)}`);
        const found = [...tenantModules.values()].find((row) => matches(row, options.where));
        return Promise.resolve(
          found === undefined ? null : Object.assign(new TenantModule(), found),
        );
      },
    ),
    find: stubMember<Repository<TenantModule>['find']>((options: { where: Where }) =>
      Promise.resolve([...tenantModules.values()].filter((row) => matches(row, options.where))),
    ),
    save: stubMember<Repository<TenantModule>['save']>((row: TenantModule) => {
      tenantModules.set(row.moduleId, Object.assign(new TenantModule(), row));
      return Promise.resolve(row);
    }),
  });
  const grantTable = stub<Repository<UserModuleAssignment>>({
    find: stubMember<Repository<UserModuleAssignment>['find']>((options: { where: Where }) =>
      Promise.resolve(
        grants
          .filter((grant) => matches(grant, options.where))
          .map((grant) =>
            Object.assign(new UserModuleAssignment(), grant, {
              module: modules.get(grant.moduleId),
            }),
          ),
      ),
    ),
    findOne: stubMember<Repository<UserModuleAssignment>['findOne']>(
      (options: { where: Where }) => {
        const found = grants.find((grant) => matches(grant, options.where));
        return Promise.resolve(
          found === undefined ? null : Object.assign(new UserModuleAssignment(), found),
        );
      },
    ),
    create: stubMember<Repository<UserModuleAssignment>['create']>(
      (dto: Partial<UserModuleAssignment>) => Object.assign(new UserModuleAssignment(), dto),
    ),
    save: stubMember<Repository<UserModuleAssignment>['save']>((row: UserModuleAssignment) => {
      const inserted = Object.assign(new UserModuleAssignment(), row, {
        id: `uma-${grants.length}`,
      });
      grants.push(inserted);
      return Promise.resolve(inserted);
    }),
    update: stubMember<Repository<UserModuleAssignment>['update']>(
      (criteria: Where, partial: Partial<UserModuleAssignment>) => {
        const hit = grants.filter((grant) => matches(grant, criteria));
        for (const grant of hit) Object.assign(grant, partial);
        return Promise.resolve({ affected: hit.length, raw: [], generatedMaps: [] });
      },
    ),
  });

  const injectedTenantModules = collaborator<Repository<TenantModule>>(
    {},
    'TenantModule repository',
  );
  const injectedUsers = collaborator<Repository<User>>({}, 'User repository');
  const manager = stub<EntityManager>({
    // bindTenantRlsContext: the set_config of the tenant GUC is recorded; the read-back answers
    // nothing, as a connection-less double does.
    query: stubMember<EntityManager['query']>((sql: string, parameters?: unknown[]) => {
      if (sql.includes('set_config') && parameters?.[0] === 'app.current_tenant') {
        locks.push(`rls:${String(parameters[1])}`);
      }
      return Promise.resolve([]);
    }),
    withRepository: stubMember<EntityManager['withRepository']>((repository: unknown) => {
      if (repository === injectedTenantModules) return tenantModuleTable;
      if (repository === injectedUsers) return userTable;
      throw new Error('withRepository: unexpected repository');
    }),
    getRepository: stubMember<EntityManager['getRepository']>((entity: unknown) => {
      if (entity === UserModuleAssignment) return grantTable;
      if (entity === TenantModule) return tenantModuleTable;
      throw new Error('getRepository: unexpected entity');
    }),
    findOneOrFail: stubMember<EntityManager['findOneOrFail']>(
      (entity: unknown, options: { where: { id: string } }) => {
        const found = entity === Module ? modules.get(options.where.id) : undefined;
        if (found === undefined) throw new Error('findOneOrFail: no such module');
        return Promise.resolve(found);
      },
    ),
  });
  const dataSource = stub<DataSource>({
    transaction: stubMember<DataSource['transaction']>(
      (work: (transactionManager: EntityManager) => Promise<unknown>) => {
        transactions.count += 1;
        return work(manager);
      },
    ),
  });

  const service = new TenantService(
    collaborator<Repository<Tenant>>({}, 'Tenant repository'),
    injectedTenantModules,
    injectedUsers,
    collaborator<Repository<RefreshToken>>({}, 'RefreshToken repository'),
    dataSource,
  );
  return {
    service,
    users,
    tenantModules,
    grants,
    locks,
    transactions,
    grantOf: (userId, code) =>
      grants.find((grant) => grant.userId === userId && grant.moduleId === MODULE_ID[code]),
    managerOf: (code) => tenantModules.get(MODULE_ID[code])?.managerId,
  };
}

/** The claim token mint builds for a member of the world, read through the one reader. */
async function moduleAccessOf(world: World, userId: string): Promise<unknown> {
  const user = world.users.get(userId);
  if (user === undefined) throw new Error('no such user');
  const memberRows = world.grants
    .filter((grant) => grant.userId === userId && grant.isActive)
    .map((grant) => {
      const code = CODES.find((candidate) => MODULE_ID[candidate] === grant.moduleId);
      return { code, name: code, defaultRoute: `/${String(code)}`, role: grant.role };
    });
  const read = await readModuleAccess(() => Promise.resolve(memberRows), {
    id: user.id,
    role: user.role,
    tenantId: TENANT,
  });
  return read.moduleAccess;
}

/**
 * RBAC-HIGH-027: Assign Manager and Remove Manager write the grants their designation implies,
 * in the transaction that writes tenant_modules.managerId (and, until PKG-06, users.role). A
 * member designated after the R1 backfill holds the module as MODULE_MANAGER, a removed one
 * falls back to what the remaining inputs give, and an hr designation never yields an hr
 * manager grant (D6).
 */
describe('TenantService Assign / Remove Manager write the implied grants (RBAC-HIGH-027)', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  describe('assignModuleManager', () => {
    it("makes a member's backfilled farm MODULE_USER grant a MODULE_MANAGER one, so the token carries it", async () => {
      const world = makeWorld({
        users: [{ id: DESIGNEE, role: Role.MODULE_USER }],
        grants: [{ userId: DESIGNEE, code: 'farm', role: 'MODULE_USER' }],
      });

      await world.service.assignModuleManager(TENANT, MODULE_ID.farm, DESIGNEE, ADMIN);

      expect(world.managerOf('farm')).toBe(DESIGNEE);
      expect(world.grantOf(DESIGNEE, 'farm')).toMatchObject({
        isActive: true,
        role: 'MODULE_MANAGER',
      });
      expect(await moduleAccessOf(world, DESIGNEE)).toEqual({ farm: 'MODULE_MANAGER' });
      expect(world.transactions.count).toBe(1);
    });

    it('gives a designee without a farm row a live one, as the backfill inserts it', async () => {
      const world = makeWorld({ users: [{ id: DESIGNEE, role: Role.MODULE_USER }] });

      await world.service.assignModuleManager(TENANT, MODULE_ID.farm, DESIGNEE, ADMIN);

      expect(world.grantOf(DESIGNEE, 'farm')).toMatchObject({
        tenantId: TENANT,
        isPrimaryManager: false,
        isActive: true,
        role: 'MODULE_MANAGER',
        assignedBy: ADMIN,
        notes: DESIGNATED_MANAGER_ROW_NOTE,
      });
    });

    it("reactivates the designee's inactive farm row", async () => {
      const world = makeWorld({
        users: [{ id: DESIGNEE, role: Role.MODULE_USER }],
        grants: [{ userId: DESIGNEE, code: 'farm', role: 'MODULE_USER', isActive: false }],
      });

      await world.service.assignModuleManager(TENANT, MODULE_ID.farm, DESIGNEE, ADMIN);

      expect(world.grants).toHaveLength(1);
      expect(world.grantOf(DESIGNEE, 'farm')).toMatchObject({
        isActive: true,
        role: 'MODULE_MANAGER',
      });
    });

    it('re-derives every grant of the designee: the legacy promotion manages each non-hr module, never hr', async () => {
      const world = makeWorld({
        users: [{ id: DESIGNEE, role: Role.MODULE_USER }],
        grants: [
          { userId: DESIGNEE, code: 'sensor', role: 'MODULE_USER' },
          { userId: DESIGNEE, code: 'hr', role: 'MODULE_USER' },
        ],
      });

      await world.service.assignModuleManager(TENANT, MODULE_ID.farm, DESIGNEE, ADMIN);

      // users.role is still promoted tenant-wide until PKG-06 (R3) stops it, and the rule keeps
      // a global MODULE_MANAGER managing every module but hr — as the backfill does.
      expect(world.users.get(DESIGNEE)?.role).toBe(Role.MODULE_MANAGER);
      expect(await moduleAccessOf(world, DESIGNEE)).toEqual({
        farm: 'MODULE_MANAGER',
        hr: 'MODULE_USER',
        sensor: 'MODULE_MANAGER',
      });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        event: 'module_manager_assigned',
        tenantId: TENANT,
        moduleCode: 'farm',
        grantRolesChanged: 1,
      });
    });

    it('writes no hr manager grant for an hr designation, and logs the case (D6)', async () => {
      const world = makeWorld({
        users: [{ id: DESIGNEE, role: Role.MODULE_USER }],
        grants: [{ userId: DESIGNEE, code: 'hr', role: 'MODULE_USER' }],
      });

      await world.service.assignModuleManager(TENANT, MODULE_ID.hr, DESIGNEE, ADMIN);

      expect(world.managerOf('hr')).toBe(DESIGNEE);
      expect(world.grantOf(DESIGNEE, 'hr')?.role).toBe('MODULE_USER');
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        event: 'module_manager_hr_grant_withheld',
        tenantId: TENANT,
        moduleId: MODULE_ID.hr,
        userId: DESIGNEE,
      });
    });

    it('inserts no hr row for an hr designee who holds none (D6)', async () => {
      const world = makeWorld({ users: [{ id: DESIGNEE, role: Role.MODULE_USER }] });

      await world.service.assignModuleManager(TENANT, MODULE_ID.hr, DESIGNEE, ADMIN);

      expect(world.grants).toEqual([]);
    });

    it('inserts no row for a module that owns no data (alert)', async () => {
      const world = makeWorld({ users: [{ id: DESIGNEE, role: Role.MODULE_USER }] });

      await world.service.assignModuleManager(TENANT, MODULE_ID.alert, DESIGNEE, ADMIN);

      expect(world.grants).toEqual([]);
    });

    it('takes the farm manager grant the designation gave the previous designee back', async () => {
      // The previous designee's users.role was set back to MODULE_USER since; only managerId
      // made them a farm manager.
      const world = makeWorld({
        users: [
          { id: PREVIOUS, role: Role.MODULE_USER },
          { id: DESIGNEE, role: Role.MODULE_USER },
        ],
        managers: { farm: PREVIOUS },
        grants: [{ userId: PREVIOUS, code: 'farm', role: 'MODULE_MANAGER' }],
      });

      await world.service.assignModuleManager(TENANT, MODULE_ID.farm, DESIGNEE, ADMIN);

      expect(world.grantOf(PREVIOUS, 'farm')?.role).toBe('MODULE_USER');
      expect(world.grantOf(DESIGNEE, 'farm')?.role).toBe('MODULE_MANAGER');
    });

    it('binds the tenant first, then locks the tenant module and the members in ascending id order', async () => {
      const world = makeWorld({
        users: [
          { id: PREVIOUS, role: Role.MODULE_USER },
          { id: DESIGNEE, role: Role.MODULE_USER },
        ],
        managers: { farm: DESIGNEE },
      });

      await world.service.assignModuleManager(TENANT, MODULE_ID.farm, PREVIOUS, ADMIN);

      expect(world.locks.filter((step) => !step.startsWith('rls:')).slice(0, 3)).toEqual([
        `tenant_module:${MODULE_ID.farm}`,
        `user:${PREVIOUS}`,
        `user:${DESIGNEE}`,
      ]);
      expect(world.locks[0]).toBe(`rls:${TENANT}`);
    });

    it('refuses a module the tenant does not have, and a user of another tenant, writing nothing', async () => {
      const world = makeWorld({
        users: [
          { id: PREVIOUS, role: Role.MODULE_USER },
          { id: DESIGNEE, role: Role.MODULE_USER, tenantId: OTHER_TENANT },
        ],
      });

      await expect(
        world.service.assignModuleManager(TENANT, 'not-a-module', PREVIOUS, ADMIN),
      ).rejects.toThrow(new NotFoundException('Module not assigned to this tenant'));
      await expect(
        world.service.assignModuleManager(TENANT, MODULE_ID.farm, DESIGNEE, ADMIN),
      ).rejects.toThrow(new NotFoundException('User not found in this tenant'));
      expect(world.managerOf('farm')).toBeNull();
      expect(world.grants).toEqual([]);
    });
  });

  describe('removeModuleManager', () => {
    it('takes back the farm manager grant only the designation gave', async () => {
      const world = makeWorld({
        users: [{ id: PREVIOUS, role: Role.MODULE_USER }],
        managers: { farm: PREVIOUS },
        grants: [{ userId: PREVIOUS, code: 'farm', role: 'MODULE_MANAGER' }],
      });

      await world.service.removeModuleManager(TENANT, MODULE_ID.farm);

      expect(world.managerOf('farm')).toBeNull();
      expect(world.grantOf(PREVIOUS, 'farm')).toMatchObject({
        isActive: true,
        role: 'MODULE_USER',
      });
      expect(await moduleAccessOf(world, PREVIOUS)).toEqual({ farm: 'MODULE_USER' });
      expect(world.locks).toEqual([
        `rls:${TENANT}`,
        `tenant_module:${MODULE_ID.farm}`,
        `user:${PREVIOUS}`,
        // The re-derivation binds the member's tenant again before it reads the grants.
        `rls:${TENANT}`,
      ]);
      expect(world.transactions.count).toBe(1);
    });

    it('keeps the grant a remaining input still gives: the primary manager, the legacy global role', async () => {
      const world = makeWorld({
        users: [
          { id: PREVIOUS, role: Role.MODULE_USER },
          { id: DESIGNEE, role: Role.MODULE_MANAGER },
        ],
        managers: { farm: PREVIOUS, sensor: DESIGNEE },
        grants: [
          { userId: PREVIOUS, code: 'farm', role: 'MODULE_MANAGER', isPrimaryManager: true },
          { userId: DESIGNEE, code: 'sensor', role: 'MODULE_MANAGER' },
        ],
      });

      await world.service.removeModuleManager(TENANT, MODULE_ID.farm);
      await world.service.removeModuleManager(TENANT, MODULE_ID.sensor);

      expect(world.grantOf(PREVIOUS, 'farm')?.role).toBe('MODULE_MANAGER');
      expect(world.grantOf(DESIGNEE, 'sensor')?.role).toBe('MODULE_MANAGER');
    });

    it('re-derives nobody when the module had no manager', async () => {
      const world = makeWorld({
        users: [{ id: PREVIOUS, role: Role.MODULE_USER }],
        grants: [{ userId: PREVIOUS, code: 'farm', role: 'MODULE_USER' }],
      });

      await world.service.removeModuleManager(TENANT, MODULE_ID.farm);

      expect(world.locks).toEqual([`rls:${TENANT}`, `tenant_module:${MODULE_ID.farm}`]);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        event: 'module_manager_removed',
        tenantId: TENANT,
        moduleCode: 'farm',
        grantRolesChanged: 0,
      });
    });
  });
});
