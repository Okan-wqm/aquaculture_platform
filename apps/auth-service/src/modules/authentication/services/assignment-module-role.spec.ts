import { OWNER_MODULE, PLATFORM_MODULE } from '@aquaculture/shared-contracts';

import { moduleAssignmentGrant, type ModuleAssignmentGrantInput } from './assignment-module-role';

/** A grant input with no manager input set, so each case names only the one it is about. */
function grantInput(overrides: Partial<ModuleAssignmentGrantInput>): ModuleAssignmentGrantInput {
  return {
    isPrimaryManager: false,
    invitedModuleRole: 'MODULE_USER',
    moduleCode: OWNER_MODULE.FARM,
    ...overrides,
  };
}

/**
 * The role an invite writes on each of its module grants (RBAC-HIGH-027, PKG-06). Since PKG-06 a
 * grant's role is explicit: setUserModuleAccess and Assign / Remove Manager write it, and nothing
 * derives it again from users.role or tenant_modules.managerId. The rule is left for the one
 * writer that names a single role for several modules, an invite, and it keeps the backfill's
 * D6 exception: an hr manager grant comes only from the primary-manager choice.
 */
describe('moduleAssignmentGrant (RBAC-HIGH-027, PKG-06)', () => {
  it.each([
    [OWNER_MODULE.FARM],
    [OWNER_MODULE.HR],
    [OWNER_MODULE.SENSOR],
    [OWNER_MODULE.HYDROPONICS],
  ])('the primary manager of %s manages it', (moduleCode) => {
    expect(moduleAssignmentGrant(grantInput({ isPrimaryManager: true, moduleCode }))).toEqual({
      isPrimaryManager: true,
      role: 'MODULE_MANAGER',
    });
  });

  it.each([[OWNER_MODULE.FARM], [OWNER_MODULE.SENSOR], [OWNER_MODULE.HYDROPONICS]])(
    'a member invited as a module manager manages %s',
    (moduleCode) => {
      expect(
        moduleAssignmentGrant(grantInput({ invitedModuleRole: 'MODULE_MANAGER', moduleCode })).role,
      ).toBe('MODULE_MANAGER');
    },
  );

  it('never makes hr managed by an invited manager role alone (D6)', () => {
    expect(
      moduleAssignmentGrant(
        grantInput({ invitedModuleRole: 'MODULE_MANAGER', moduleCode: OWNER_MODULE.HR }),
      ),
    ).toEqual({ isPrimaryManager: false, role: 'MODULE_USER' });
  });

  it('a member invited as a module user uses each module', () => {
    for (const moduleCode of Object.values(OWNER_MODULE)) {
      expect(moduleAssignmentGrant(grantInput({ moduleCode })).role).toBe('MODULE_USER');
    }
  });

  it('writes a role on the non-owner rows too, which the claim then leaves out', () => {
    expect(
      moduleAssignmentGrant(
        grantInput({ invitedModuleRole: 'MODULE_MANAGER', moduleCode: PLATFORM_MODULE.ALERT }),
      ).role,
    ).toBe('MODULE_MANAGER');
  });
});
