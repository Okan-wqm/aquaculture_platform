/**
 * The role a module assignment holds (RBAC-HIGH-027; ADR-051 §2 "Backfill").
 *
 * WHY: a module grant carried no role. The per-module manager choice lived only in
 * `isPrimaryManager` and `tenant_modules.managerId`, which token mint never read, so the only way
 * to make someone a manager was the tenant-wide users.role. Release R1 adds
 * `user_module_assignments.role`; until PKG-06 gives tenant admins a per-module role of their
 * own, the role is derived from those inputs by the rule the backfill
 * (1819400000000-BackfillUserModuleAssignmentRole) applies to the rows that exist at R1.
 *
 * WHAT: MODULE_MANAGER for the module's primary manager; MODULE_MANAGER for the module's
 * designated manager (tenant_modules.managerId) or a legacy global MODULE_MANAGER in any module
 * but hr, which keeps the power that user has today; MODULE_USER otherwise. An hr manager grant
 * comes only from the primary-manager choice (owner decision D6: pay is visible only inside HR,
 * so neither Assign Manager nor the tenant-wide role may open it). This is the one place users.role
 * still informs a grant, and only when the grant is written: the module-access reader reads the
 * row and never users.role. PKG-46 demotes the global role in R6.
 *
 * The rule holds over the inputs as they stand, not as they stood when the row was written: a
 * writer that inserts a row derives its role here, and every writer of an input — Assign and
 * Remove Manager (managerId and users.role) and the admin role edit (users.role) — re-derives
 * the member's rows in its own transaction (tenant/services/module-grant-rederivation.ts). The
 * one exception is a row whose input a container of the R0 image changed after the R1 migration
 * (the rollout window, or an image rollback): the backfill fills only rows without a role, so
 * such a row keeps its role until the member's next re-derivation.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import { OWNER_MODULE, PLATFORM_ROLE, type ModuleRole } from '@aquaculture/shared-contracts';

export interface ModuleAssignmentGrantInput {
  /** The admin chose this member as the module's primary manager. */
  readonly isPrimaryManager: boolean;
  /** The member is the module's designated manager (tenant_modules.managerId, Assign Manager). */
  readonly isDesignatedManager: boolean;
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
    (input.moduleCode !== OWNER_MODULE.HR &&
      (input.isDesignatedManager || input.userRole === Role.MODULE_MANAGER));
  return {
    isPrimaryManager: input.isPrimaryManager,
    role: managesModule ? PLATFORM_ROLE.MODULE_MANAGER : PLATFORM_ROLE.MODULE_USER,
  };
}
