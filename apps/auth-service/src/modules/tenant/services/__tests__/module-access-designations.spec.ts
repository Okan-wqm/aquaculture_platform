import { Logger } from '@nestjs/common';

import { ADMIN, Role, TENANT, actor, makeWorld } from './support/module-access-world';

const PRIMARY = '11111111-1111-4111-8111-111111111111';
const LEGACY = '22222222-2222-4222-8222-222222222222';
const HR_LEGACY = '33333333-3333-4333-8333-333333333333';
const LAPSED = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

/**
 * Who manages each module, as the console shows it (PKG-06; RBAC-MEDIUM-036). The designation
 * lived in two copies — tenant_modules.managerId, which no token reads, and the primary manager
 * row — so the console could name a manager who held no manager grant. The listing reads both
 * copies through one reader and shows a designated member only while a live MODULE_MANAGER grant
 * in the module backs the designation: the fact the token carries.
 */
describe('ModuleAccessService.listPrimaryManagers', () => {
  it('lists the designated members who hold the module manager grant, per enabled owner module', async () => {
    const world = makeWorld({
      users: [
        { id: PRIMARY, role: Role.MODULE_USER },
        { id: LEGACY, role: Role.MODULE_MANAGER },
        { id: HR_LEGACY, role: Role.MODULE_MANAGER },
        { id: LAPSED, role: Role.MODULE_USER },
      ],
      disabled: ['hydroponics'],
      // An earlier release's Assign Manager wrote managerId only (the R1 backfill gave the sensor
      // designee a manager row, and the hr designee none: D6).
      managers: { sensor: LEGACY, hr: HR_LEGACY, hydroponics: PRIMARY },
      grants: [
        { userId: PRIMARY, code: 'farm', role: 'MODULE_MANAGER', isPrimaryManager: true },
        {
          userId: LAPSED,
          code: 'farm',
          role: 'MODULE_MANAGER',
          isPrimaryManager: true,
          isActive: false,
        },
        { userId: LEGACY, code: 'sensor', role: 'MODULE_MANAGER' },
        { userId: HR_LEGACY, code: 'hr', role: 'MODULE_USER' },
        { userId: PRIMARY, code: 'hydroponics', role: 'MODULE_MANAGER', isPrimaryManager: true },
      ],
    });

    await expect(world.service.listPrimaryManagers(TENANT)).resolves.toEqual([
      { moduleCode: 'farm', userId: PRIMARY },
      { moduleCode: 'sensor', userId: LEGACY },
    ]);
    expect(world.steps[0]).toBe(`rls:${TENANT}`);
  });
});

describe('ModuleAccessService.setUserModuleAccess — a designation without a grant', () => {
  it('clears the legacy designation and audits it, invalidating no token when no grant moved', async () => {
    const world = makeWorld({
      users: [{ id: HR_LEGACY, role: Role.MODULE_MANAGER }],
      managers: { hr: HR_LEGACY },
    });

    await world.service.setUserModuleAccess(actor(), { userId: HR_LEGACY, moduleAccess: {} });

    expect(world.managerOf('hr')).toBeNull();
    expect(world.invalidations).toEqual([]);
    expect(world.audits).toEqual([
      {
        inTransaction: true,
        dto: expect.objectContaining({
          tenantId: TENANT,
          performedBy: ADMIN,
          action: 'USER_MODULE_ACCESS_SET',
          entityId: HR_LEGACY,
          details: { changes: [], designationsEnded: ['hr'] },
        }),
      },
    ]);
  });
});
