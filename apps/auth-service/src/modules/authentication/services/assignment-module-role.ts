/**
 * The role an invite writes on each module grant it creates (RBAC-HIGH-027; PKG-06).
 *
 * WHY: release R1 gave every grant a role (`user_module_assignments.role`) and, with no
 * per-module role an admin could set, derived it from users.role, tenant_modules.managerId and
 * the row's isPrimaryManager — the rule of the backfill (1819400000000). PKG-06 gives admins the
 * per-module role itself: setUserModuleAccess and Assign / Remove Manager write it explicitly.
 * The R1 rule then conflicts with them: re-deriving a member's rows from users.role whenever an
 * input changed (the former module-grant-rederivation.ts) overwrote an explicit choice — an
 * explicit {farm: MODULE_USER} for a legacy global MODULE_MANAGER came back as MODULE_MANAGER on
 * the next role edit, and an explicit {sensor: MODULE_MANAGER} for a member fell back to
 * MODULE_USER. The conflict is resolved in the rule: a stored role is the grant, and the legacy
 * global role counts only where no role is stored yet — the backfill of roleless rows, whose
 * SQL keeps the R1 rule. users.role is an account role (ADR-051 §1), and PKG-46's demotion of the
 * global role "changes no access decision" precisely because grants no longer depend on it.
 *
 * WHAT: the one writer that names a single role for several modules is an invite. Its grants
 * take that role, with the backfill's D6 exception: an hr manager grant comes only from the
 * primary-manager choice, never from a role named for several modules at once.
 */
import { OWNER_MODULE, PLATFORM_ROLE, type ModuleRole } from '@aquaculture/shared-contracts';

export interface ModuleAssignmentGrantInput {
  /** The invite chose this module as the member's primary managed module. */
  readonly isPrimaryManager: boolean;
  /** The module role the invite named for all its modules. */
  readonly invitedModuleRole: ModuleRole;
  /** The code of the module (`auth.modules.code`). */
  readonly moduleCode: string;
}

/** The two columns of a grant its writer sets together. */
export interface ModuleAssignmentGrant {
  readonly isPrimaryManager: boolean;
  readonly role: ModuleRole;
}

export function moduleAssignmentGrant(input: ModuleAssignmentGrantInput): ModuleAssignmentGrant {
  const managesModule =
    input.isPrimaryManager ||
    (input.moduleCode !== OWNER_MODULE.HR &&
      input.invitedModuleRole === PLATFORM_ROLE.MODULE_MANAGER);
  return {
    isPrimaryManager: input.isPrimaryManager,
    role: managesModule ? PLATFORM_ROLE.MODULE_MANAGER : PLATFORM_ROLE.MODULE_USER,
  };
}
