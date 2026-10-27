import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';

import { DESIGNATED_MANAGER_ROW_NOTE } from '../module-manager-designation';

import {
  ADMIN,
  MODULE_ID,
  OTHER_TENANT,
  Role,
  TENANT,
  actor,
  makeWorld,
} from './support/module-access-world';

const MEMBER = '22222222-2222-4222-8222-222222222222';
const PREVIOUS = '11111111-1111-4111-8111-111111111111';
const TENANT_ADMIN_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

/**
 * setUserModuleAccess (PKG-06; ADR-051 §2 "Change"): an admin states a member's whole set of
 * module roles. The replace touches only the modules the tenant has enabled, and in the one
 * transaction that writes the grants it invalidates the member's access tokens (their next
 * refresh mints the new claim) and writes an audit row. Nothing writes users.role.
 */
describe('ModuleAccessService.setUserModuleAccess', () => {
  it("replaces a member's grants within the enabled modules and answers the new claim", async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      grants: [
        { userId: MEMBER, code: 'farm', role: 'MODULE_USER' },
        { userId: MEMBER, code: 'sensor', role: 'MODULE_MANAGER' },
      ],
    });

    const result = await world.service.setUserModuleAccess(actor(), {
      userId: MEMBER,
      moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_USER' },
    });

    expect(result).toEqual({
      userId: MEMBER,
      moduleAccess: { farm: 'MODULE_MANAGER', hr: 'MODULE_USER' },
    });
    expect(world.grantOf(MEMBER, 'farm')).toMatchObject({ isActive: true, role: 'MODULE_MANAGER' });
    expect(world.grantOf(MEMBER, 'hr')).toMatchObject({
      tenantId: TENANT,
      isActive: true,
      isPrimaryManager: false,
      role: 'MODULE_USER',
      assignedBy: ADMIN,
    });
    expect(world.grantOf(MEMBER, 'sensor')).toMatchObject({ isActive: false });
    expect(world.savedUsers).toEqual([]);
    expect(world.transactions.count).toBe(1);
  });

  it("invalidates the member's tokens and writes the audit row in the same transaction", async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      grants: [{ userId: MEMBER, code: 'farm', role: 'MODULE_USER' }],
    });

    await world.service.setUserModuleAccess(actor(), {
      userId: MEMBER,
      moduleAccess: { sensor: 'MODULE_USER' },
    });

    expect(world.invalidations).toEqual([
      {
        inTransaction: true,
        intent: expect.objectContaining({
          userId: MEMBER,
          tenantId: TENANT,
          reason: 'role_permissions_changed',
        }),
      },
    ]);
    expect(world.audits).toEqual([
      {
        inTransaction: true,
        dto: expect.objectContaining({
          tenantId: TENANT,
          performedBy: ADMIN,
          action: 'USER_MODULE_ACCESS_SET',
          entityType: 'UserModuleAccess',
          entityId: MEMBER,
          previousValue: { moduleAccess: { farm: 'MODULE_USER' } },
          newValue: { moduleAccess: { sensor: 'MODULE_USER' } },
        }),
      },
    ]);
    // After commit the request path cuts the live tokens at once.
    expect(world.applied).toHaveBeenCalledWith(world.invalidations[0]?.intent);
  });

  it('still answers when the immediate invalidation fails after commit (the durable intent stands)', async () => {
    const world = makeWorld({ users: [{ id: MEMBER, role: Role.MODULE_USER }] });
    world.applied.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      world.service.setUserModuleAccess(actor(), {
        userId: MEMBER,
        moduleAccess: { farm: 'MODULE_USER' },
      }),
    ).resolves.toEqual({ userId: MEMBER, moduleAccess: { farm: 'MODULE_USER' } });
    expect(world.invalidations).toHaveLength(1);
  });

  it('writes, invalidates and audits nothing when the grants already are as stated', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      grants: [{ userId: MEMBER, code: 'farm', role: 'MODULE_USER' }],
    });

    await world.service.setUserModuleAccess(actor(), {
      userId: MEMBER,
      moduleAccess: { farm: 'MODULE_USER' },
    });

    expect(world.invalidations).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.applied).not.toHaveBeenCalled();
  });

  it('leaves the rows of a module the tenant has disabled alone', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      disabled: ['hydroponics'],
      grants: [{ userId: MEMBER, code: 'hydroponics', role: 'MODULE_MANAGER' }],
    });

    const result = await world.service.setUserModuleAccess(actor(), {
      userId: MEMBER,
      moduleAccess: { farm: 'MODULE_USER' },
    });

    expect(world.grantOf(MEMBER, 'hydroponics')).toMatchObject({
      isActive: true,
      role: 'MODULE_MANAGER',
    });
    expect(result.moduleAccess).toEqual({ farm: 'MODULE_USER' });
  });

  it('refuses a module the tenant has not enabled, writing nothing', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      disabled: ['hydroponics'],
    });

    await expect(
      world.service.setUserModuleAccess(actor(), {
        userId: MEMBER,
        moduleAccess: { farm: 'MODULE_USER', hydroponics: 'MODULE_USER' },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(world.grants).toEqual([]);
    expect(world.invalidations).toEqual([]);
    expect(world.audits).toEqual([]);
  });

  it('refuses a tenant administrator (who holds every enabled module) and a user of another tenant', async () => {
    const world = makeWorld({
      users: [
        { id: TENANT_ADMIN_ID, role: Role.TENANT_ADMIN },
        { id: MEMBER, role: Role.MODULE_USER, tenantId: OTHER_TENANT },
      ],
    });

    await expect(
      world.service.setUserModuleAccess(actor(), {
        userId: TENANT_ADMIN_ID,
        moduleAccess: { farm: 'MODULE_USER' },
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      world.service.setUserModuleAccess(actor(), {
        userId: MEMBER,
        moduleAccess: { farm: 'MODULE_USER' },
      }),
    ).rejects.toThrow(NotFoundException);
    expect(world.grants).toEqual([]);
  });

  it("takes the module's primary designation with a manager grant it lowers or removes", async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      managers: { farm: MEMBER, sensor: MEMBER },
      grants: [
        { userId: MEMBER, code: 'farm', role: 'MODULE_MANAGER', isPrimaryManager: true },
        { userId: MEMBER, code: 'sensor', role: 'MODULE_MANAGER', isPrimaryManager: true },
      ],
    });

    await world.service.setUserModuleAccess(actor(), {
      userId: MEMBER,
      moduleAccess: { farm: 'MODULE_USER' },
    });

    expect(world.grantOf(MEMBER, 'farm')).toMatchObject({
      isPrimaryManager: false,
      role: 'MODULE_USER',
    });
    expect(world.grantOf(MEMBER, 'sensor')).toMatchObject({
      isPrimaryManager: false,
      isActive: false,
    });
    expect(world.managerOf('farm')).toBeNull();
    expect(world.managerOf('sensor')).toBeNull();
  });

  it('binds the tenant, then locks the enabled tenant modules, then the member', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      disabled: ['hydroponics', 'alert'],
    });

    await world.service.setUserModuleAccess(actor(), {
      userId: MEMBER,
      moduleAccess: { hr: 'MODULE_USER' },
    });

    expect(world.steps).toEqual([
      `rls:${TENANT}`,
      'tenant_module:farm',
      'tenant_module:hr',
      'tenant_module:sensor',
      `user:${MEMBER}`,
    ]);
  });
});

/**
 * Assign Manager by module code (PKG-06; RBAC-HIGH-034, RBAC-MEDIUM-036). The designation is the
 * module's primary manager grant — one fact, in user_module_assignments, the store the token
 * reads. It never writes users.role: naming a farm manager no longer makes them a manager of
 * every module. Replacing or removing a manager takes the manager grant back. Each change
 * invalidates the affected members' tokens and writes an audit row, in one transaction.
 */
describe('ModuleAccessService.assignModuleManager', () => {
  it("gives the designee the module's primary manager grant and leaves users.role alone", async () => {
    const world = makeWorld({ users: [{ id: MEMBER, role: Role.MODULE_USER }] });

    await world.service.assignModuleManager(actor(), {
      module: { moduleCode: 'farm' },
      userId: MEMBER,
    });

    expect(world.grantOf(MEMBER, 'farm')).toMatchObject({
      tenantId: TENANT,
      isActive: true,
      isPrimaryManager: true,
      role: 'MODULE_MANAGER',
      assignedBy: ADMIN,
      notes: DESIGNATED_MANAGER_ROW_NOTE,
    });
    expect(world.users.get(MEMBER)?.role).toBe(Role.MODULE_USER);
    expect(world.savedUsers).toEqual([]);
    expect(world.managerOf('farm')).toBe(MEMBER);
  });

  it("makes the designee's existing farm grant the primary manager grant, reactivating it", async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      grants: [{ userId: MEMBER, code: 'farm', role: 'MODULE_USER', isActive: false }],
    });

    await world.service.assignModuleManager(actor(), {
      module: { moduleCode: 'farm' },
      userId: MEMBER,
    });

    expect(world.grants).toHaveLength(1);
    expect(world.grantOf(MEMBER, 'farm')).toMatchObject({
      isActive: true,
      isPrimaryManager: true,
      role: 'MODULE_MANAGER',
    });
  });

  it('never promotes a legacy member tenant-wide: their other grants stay as they are', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      grants: [{ userId: MEMBER, code: 'sensor', role: 'MODULE_USER' }],
    });

    await world.service.assignModuleManager(actor(), {
      module: { moduleCode: 'farm' },
      userId: MEMBER,
    });

    expect(world.grantOf(MEMBER, 'sensor')?.role).toBe('MODULE_USER');
  });

  it('takes the manager grant back from every previous designation of the module', async () => {
    const LEGACY = '44444444-4444-4444-8444-444444444444';
    const world = makeWorld({
      users: [
        { id: PREVIOUS, role: Role.MODULE_USER },
        { id: LEGACY, role: Role.MODULE_MANAGER },
        { id: MEMBER, role: Role.MODULE_USER },
      ],
      // LEGACY was designated by the old Assign Manager (managerId only); PREVIOUS is the
      // primary manager an invite chose.
      managers: { farm: LEGACY },
      grants: [
        { userId: PREVIOUS, code: 'farm', role: 'MODULE_MANAGER', isPrimaryManager: true },
        { userId: LEGACY, code: 'farm', role: 'MODULE_MANAGER' },
      ],
    });

    await world.service.assignModuleManager(actor(), {
      module: { moduleCode: 'farm' },
      userId: MEMBER,
    });

    for (const previous of [PREVIOUS, LEGACY]) {
      expect(world.grantOf(previous, 'farm')).toMatchObject({
        isActive: true,
        isPrimaryManager: false,
        role: 'MODULE_USER',
      });
    }
    expect(world.users.get(LEGACY)?.role).toBe(Role.MODULE_MANAGER);
    expect(world.invalidations.map((record) => record.intent.userId).sort()).toEqual(
      [MEMBER, PREVIOUS, LEGACY].sort(),
    );
    expect(world.invalidations.every((record) => record.inTransaction)).toBe(true);
    expect(world.audits).toEqual([
      {
        inTransaction: true,
        dto: expect.objectContaining({
          tenantId: TENANT,
          performedBy: ADMIN,
          action: 'MODULE_MANAGER_ASSIGNED',
          entityType: 'TenantModule',
          entityId: 'tm-farm',
          newValue: { moduleCode: 'farm', managerId: MEMBER },
        }),
      },
    ]);
  });

  it('designates an hr manager with an hr manager grant: the per-module choice D6 admits', async () => {
    const world = makeWorld({ users: [{ id: MEMBER, role: Role.MODULE_USER }] });

    await world.service.assignModuleManager(actor(), {
      module: { moduleCode: 'hr' },
      userId: MEMBER,
    });

    expect(world.grantOf(MEMBER, 'hr')).toMatchObject({
      isPrimaryManager: true,
      role: 'MODULE_MANAGER',
    });
  });

  it('takes the module id the release-R2 web sends', async () => {
    const world = makeWorld({ users: [{ id: MEMBER, role: Role.MODULE_USER }] });

    await world.service.assignModuleManager(actor(), {
      module: { moduleId: MODULE_ID.sensor },
      userId: MEMBER,
    });

    expect(world.grantOf(MEMBER, 'sensor')?.role).toBe('MODULE_MANAGER');
  });

  it('binds the tenant, then locks the tenant module, then the members in ascending id order', async () => {
    const world = makeWorld({
      users: [
        { id: PREVIOUS, role: Role.MODULE_USER },
        { id: MEMBER, role: Role.MODULE_USER },
      ],
      managers: { farm: MEMBER },
    });

    await world.service.assignModuleManager(actor(), {
      module: { moduleCode: 'farm' },
      userId: PREVIOUS,
    });

    expect(world.steps).toEqual([
      `rls:${TENANT}`,
      'tenant_module:farm',
      `user:${PREVIOUS}`,
      `user:${MEMBER}`,
    ]);
  });

  it.each([
    [
      'a module that owns no data named by its code (alert)',
      { moduleCode: 'alert' },
      BadRequestException,
    ],
    ['a code that is no module', { moduleCode: 'payroll' }, BadRequestException],
    ['a module id the tenant does not hold', { moduleId: 'not-a-module' }, NotFoundException],
  ])('refuses %s, writing nothing', async (_label, module, error) => {
    const world = makeWorld({ users: [{ id: MEMBER, role: Role.MODULE_USER }] });

    await expect(
      world.service.assignModuleManager(actor(), { module, userId: MEMBER }),
    ).rejects.toThrow(error);
    expect(world.grants).toEqual([]);
    expect(world.managerOf('alert')).toBeNull();
    expect(world.audits).toEqual([]);
  });

  // C6 (b): the R2 console shows a card for every module of the session and sends its id. A
  // module disabled since the session began is designated as an enabled one: the grant is inert
  // while the module is off, since the token reader joins tenant_modules.isEnabled.
  it('designates a disabled module as an enabled one, the R2 console may still send it', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER }],
      disabled: ['hydroponics'],
    });

    await world.service.assignModuleManager(actor(), {
      module: { moduleId: MODULE_ID.hydroponics },
      userId: MEMBER,
    });

    expect(world.grantOf(MEMBER, 'hydroponics')).toMatchObject({
      isPrimaryManager: true,
      role: 'MODULE_MANAGER',
    });
    expect(world.savedUsers).toEqual([]);
  });

  // C6 (b): the R2 console offers Assign Manager on a module that owns no data and sends its id.
  // Refusing it is a BREAKING change for a release with migrations, so until PKG-06 PR2 unmaps
  // managerId (R4) its designation stays that column alone: no grant, no users.role, no token.
  it("keeps the R2 console's designation of a module that owns no data in managerId alone, audited", async () => {
    const world = makeWorld({
      users: [
        { id: PREVIOUS, role: Role.MODULE_USER },
        { id: MEMBER, role: Role.MODULE_USER },
      ],
      managers: { alert: PREVIOUS },
    });

    await world.service.assignModuleManager(actor(), {
      module: { moduleId: MODULE_ID.alert },
      userId: MEMBER,
    });

    expect(world.managerOf('alert')).toBe(MEMBER);
    expect(world.grants).toEqual([]);
    expect(world.savedUsers).toEqual([]);
    expect(world.invalidations).toEqual([]);
    expect(world.audits).toEqual([
      {
        inTransaction: true,
        dto: expect.objectContaining({
          tenantId: TENANT,
          performedBy: ADMIN,
          action: 'MODULE_MANAGER_ASSIGNED',
          entityType: 'TenantModule',
          entityId: 'tm-alert',
          previousValue: { moduleCode: 'alert', managerIds: [PREVIOUS] },
          newValue: { moduleCode: 'alert', managerId: MEMBER },
        }),
      },
    ]);
  });

  it('refuses a user of another tenant on a module that owns no data, writing nothing', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER, tenantId: OTHER_TENANT }],
    });

    await expect(
      world.service.assignModuleManager(actor(), {
        module: { moduleId: MODULE_ID.alert },
        userId: MEMBER,
      }),
    ).rejects.toThrow(new NotFoundException('User not found in this tenant'));
    expect(world.managerOf('alert')).toBeNull();
    expect(world.audits).toEqual([]);
  });

  it('refuses a user of another tenant', async () => {
    const world = makeWorld({
      users: [{ id: MEMBER, role: Role.MODULE_USER, tenantId: OTHER_TENANT }],
    });

    await expect(
      world.service.assignModuleManager(actor(), {
        module: { moduleCode: 'farm' },
        userId: MEMBER,
      }),
    ).rejects.toThrow(new NotFoundException('User not found in this tenant'));
    expect(world.managerOf('farm')).toBeNull();
  });
});

describe('ModuleAccessService.removeModuleManager', () => {
  it("takes the manager grant back, clears the designation and invalidates the former manager's tokens", async () => {
    const world = makeWorld({
      users: [{ id: PREVIOUS, role: Role.MODULE_USER }],
      managers: { farm: PREVIOUS },
      grants: [{ userId: PREVIOUS, code: 'farm', role: 'MODULE_MANAGER', isPrimaryManager: true }],
    });

    await world.service.removeModuleManager(actor(), { module: { moduleCode: 'farm' } });

    expect(world.grantOf(PREVIOUS, 'farm')).toMatchObject({
      isActive: true,
      isPrimaryManager: false,
      role: 'MODULE_USER',
    });
    expect(world.managerOf('farm')).toBeNull();
    expect(world.invalidations.map((record) => record.intent.userId)).toEqual([PREVIOUS]);
    expect(world.audits.map((record) => record.dto.action)).toEqual(['MODULE_MANAGER_REMOVED']);
  });

  it('writes, invalidates and audits nothing when the module has no manager', async () => {
    const world = makeWorld({
      users: [{ id: PREVIOUS, role: Role.MODULE_USER }],
      grants: [{ userId: PREVIOUS, code: 'farm', role: 'MODULE_USER' }],
    });

    await world.service.removeModuleManager(actor(), { module: { moduleCode: 'farm' } });

    expect(world.invalidations).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.steps).toEqual([`rls:${TENANT}`, 'tenant_module:farm']);
  });

  it("clears the R2 console's designation of a module that owns no data, audited, invalidating no token", async () => {
    const world = makeWorld({
      users: [{ id: PREVIOUS, role: Role.MODULE_USER }],
      managers: { alert: PREVIOUS },
    });

    await world.service.removeModuleManager(actor(), { module: { moduleId: MODULE_ID.alert } });

    expect(world.managerOf('alert')).toBeNull();
    expect(world.invalidations).toEqual([]);
    expect(world.audits.map((record) => record.dto)).toEqual([
      expect.objectContaining({
        action: 'MODULE_MANAGER_REMOVED',
        entityId: 'tm-alert',
        previousValue: { moduleCode: 'alert', managerIds: [PREVIOUS] },
        newValue: { moduleCode: 'alert', managerId: null },
      }),
    ]);
  });

  it('refuses a module that owns no data named by its code, writing nothing', async () => {
    const world = makeWorld({
      users: [{ id: PREVIOUS, role: Role.MODULE_USER }],
      managers: { alert: PREVIOUS },
    });

    await expect(
      world.service.removeModuleManager(actor(), { module: { moduleCode: 'alert' } }),
    ).rejects.toThrow(BadRequestException);
    expect(world.managerOf('alert')).toBe(PREVIOUS);
    expect(world.audits).toEqual([]);
  });
});
