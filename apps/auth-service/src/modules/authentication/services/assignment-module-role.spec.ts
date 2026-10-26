import { Role } from '@aquaculture/backend-common/decorators';
import { OWNER_MODULE, PLATFORM_MODULE } from '@aquaculture/shared-contracts';

import { moduleAssignmentGrant } from './assignment-module-role';

/**
 * RBAC-HIGH-027 — the role a module assignment is written with, until PKG-06 gives tenant
 * admins a per-module role of their own. It is the rule of the backfill
 * (1819400000000-BackfillUserModuleAssignmentRole), so a row written after R1 holds exactly what
 * the backfill would have given it, and an hr manager grant comes only from the per-module
 * manager choice (D6), never from the tenant-wide users.role.
 */
describe('moduleAssignmentGrant (RBAC-HIGH-027)', () => {
  it.each([
    [OWNER_MODULE.FARM],
    [OWNER_MODULE.HR],
    [OWNER_MODULE.SENSOR],
    [OWNER_MODULE.HYDROPONICS],
  ])('a primary manager of %s manages it, whatever users.role says', (moduleCode) => {
    expect(
      moduleAssignmentGrant({ isPrimaryManager: true, userRole: Role.MODULE_USER, moduleCode }),
    ).toEqual({ isPrimaryManager: true, role: 'MODULE_MANAGER' });
  });

  it.each([[OWNER_MODULE.FARM], [OWNER_MODULE.SENSOR], [OWNER_MODULE.HYDROPONICS]])(
    'a legacy global MODULE_MANAGER keeps managing %s, as today',
    (moduleCode) => {
      expect(
        moduleAssignmentGrant({
          isPrimaryManager: false,
          userRole: Role.MODULE_MANAGER,
          moduleCode,
        }).role,
      ).toBe('MODULE_MANAGER');
    },
  );

  it('never derives an hr manager grant from the global MODULE_MANAGER role (D6)', () => {
    expect(
      moduleAssignmentGrant({
        isPrimaryManager: false,
        userRole: Role.MODULE_MANAGER,
        moduleCode: OWNER_MODULE.HR,
      }),
    ).toEqual({ isPrimaryManager: false, role: 'MODULE_USER' });
  });

  it.each([[Role.MODULE_USER], [Role.TENANT_ADMIN], [Role.SUPER_ADMIN]])(
    'a %s who is not the primary manager uses the module',
    (userRole) => {
      expect(
        moduleAssignmentGrant({
          isPrimaryManager: false,
          userRole,
          moduleCode: OWNER_MODULE.FARM,
        }).role,
      ).toBe('MODULE_USER');
    },
  );

  it('writes a role on the non-owner rows too, which the claim then leaves out', () => {
    expect(
      moduleAssignmentGrant({
        isPrimaryManager: false,
        userRole: Role.MODULE_MANAGER,
        moduleCode: PLATFORM_MODULE.ALERT,
      }).role,
    ).toBe('MODULE_MANAGER');
  });
});
