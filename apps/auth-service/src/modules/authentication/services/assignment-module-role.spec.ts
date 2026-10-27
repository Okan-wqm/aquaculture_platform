import { Role } from '@aquaculture/backend-common/decorators';
import { OWNER_MODULE, PLATFORM_MODULE } from '@aquaculture/shared-contracts';

import { moduleAssignmentGrant, type ModuleAssignmentGrantInput } from './assignment-module-role';

/** A grant input with no manager input set, so each case names only the one it is about. */
function grantInput(overrides: Partial<ModuleAssignmentGrantInput>): ModuleAssignmentGrantInput {
  return {
    isPrimaryManager: false,
    isDesignatedManager: false,
    userRole: Role.MODULE_USER,
    moduleCode: OWNER_MODULE.FARM,
    ...overrides,
  };
}

/**
 * RBAC-HIGH-027 — the role a module assignment holds, until PKG-06 gives tenant admins a
 * per-module role of their own. It is the rule of the backfill
 * (1819400000000-BackfillUserModuleAssignmentRole), applied by every writer of a row or of one of
 * its inputs, and an hr manager grant comes only from the per-module manager choice (D6), never
 * from the tenant-wide users.role or from Assign Manager.
 */
describe('moduleAssignmentGrant (RBAC-HIGH-027)', () => {
  it.each([
    [OWNER_MODULE.FARM],
    [OWNER_MODULE.HR],
    [OWNER_MODULE.SENSOR],
    [OWNER_MODULE.HYDROPONICS],
  ])('a primary manager of %s manages it, whatever users.role says', (moduleCode) => {
    expect(moduleAssignmentGrant(grantInput({ isPrimaryManager: true, moduleCode }))).toEqual({
      isPrimaryManager: true,
      role: 'MODULE_MANAGER',
    });
  });

  it.each([[OWNER_MODULE.FARM], [OWNER_MODULE.SENSOR], [OWNER_MODULE.HYDROPONICS]])(
    'a legacy global MODULE_MANAGER keeps managing %s, as today',
    (moduleCode) => {
      expect(
        moduleAssignmentGrant(grantInput({ userRole: Role.MODULE_MANAGER, moduleCode })).role,
      ).toBe('MODULE_MANAGER');
    },
  );

  it.each([[OWNER_MODULE.FARM], [OWNER_MODULE.SENSOR], [OWNER_MODULE.HYDROPONICS]])(
    "the designated manager of %s manages it, whatever users.role says (Assign Manager's managerId)",
    (moduleCode) => {
      expect(
        moduleAssignmentGrant(grantInput({ isDesignatedManager: true, moduleCode })).role,
      ).toBe('MODULE_MANAGER');
    },
  );

  it('never derives an hr manager grant from the global MODULE_MANAGER role (D6)', () => {
    expect(
      moduleAssignmentGrant(
        grantInput({ userRole: Role.MODULE_MANAGER, moduleCode: OWNER_MODULE.HR }),
      ),
    ).toEqual({ isPrimaryManager: false, role: 'MODULE_USER' });
  });

  it('never derives an hr manager grant from an Assign Manager designation (D6)', () => {
    expect(
      moduleAssignmentGrant(
        grantInput({
          isDesignatedManager: true,
          userRole: Role.MODULE_MANAGER,
          moduleCode: OWNER_MODULE.HR,
        }),
      ).role,
    ).toBe('MODULE_USER');
  });

  it.each([[Role.MODULE_USER], [Role.TENANT_ADMIN], [Role.SUPER_ADMIN]])(
    'a %s who neither is the primary nor the designated manager uses the module',
    (userRole) => {
      expect(moduleAssignmentGrant(grantInput({ userRole })).role).toBe('MODULE_USER');
    },
  );

  it('writes a role on the non-owner rows too, which the claim then leaves out', () => {
    expect(
      moduleAssignmentGrant(
        grantInput({ userRole: Role.MODULE_MANAGER, moduleCode: PLATFORM_MODULE.ALERT }),
      ).role,
    ).toBe('MODULE_MANAGER');
  });
});
