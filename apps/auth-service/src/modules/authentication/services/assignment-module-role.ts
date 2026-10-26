/**
 * The role a module assignment is written with (RBAC-HIGH-027; ADR-051 §2 "Backfill").
 *
 * WHY: a module grant carried no role. The per-module manager choice lived only in
 * `isPrimaryManager`, which token mint never read, so the only way to make someone a manager was
 * the tenant-wide users.role. Release R1 adds `user_module_assignments.role`; until PKG-06 gives
 * tenant admins a per-module role of their own, every writer derives it with the rule the
 * backfill (1819400000000-BackfillUserModuleAssignmentRole) applies to the existing rows, so a
 * row written after R1 holds exactly what the backfill would have given it.
 *
 * WHAT: MODULE_MANAGER for the module's primary manager; MODULE_MANAGER for a legacy global
 * MODULE_MANAGER in any module but hr, which keeps the power that user has today; MODULE_USER
 * otherwise. An hr manager grant comes only from the primary-manager choice (owner decision D6:
 * pay is visible only inside HR, so the tenant-wide role must never open it). This is the one
 * place users.role still informs a grant, and only when the grant is written: the module-access
 * reader reads the row and never users.role. PKG-46 demotes the global role in R6.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import { OWNER_MODULE, PLATFORM_ROLE, type ModuleRole } from '@aquaculture/shared-contracts';

export interface ModuleAssignmentGrantInput {
  /** The admin chose this member as the module's primary manager. */
  readonly isPrimaryManager: boolean;
  /** The member's users.role when the grant is written. */
  readonly userRole: Role;
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
    (input.moduleCode !== OWNER_MODULE.HR && input.userRole === Role.MODULE_MANAGER);
  return {
    isPrimaryManager: input.isPrimaryManager,
    role: managesModule ? PLATFORM_ROLE.MODULE_MANAGER : PLATFORM_ROLE.MODULE_USER,
  };
}
