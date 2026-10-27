/**
 * users.role for a new account (ADR-051 §1; RBAC-HIGH-034).
 *
 * WHY: users.role was written with whatever role a writer was handed, module roles included, so
 * an invited "module manager" became a manager of every module, HR payroll included. users.role
 * is an account role: SUPER_ADMIN or TENANT_ADMIN, or MODULE_USER as the column's value for a
 * member with no account power. A member's module roles live only in their grants.
 *
 * WHAT: `usersRoleColumn` takes the account role as an AccountRole (or null for a member), so no
 * writer of a new account can name MODULE_MANAGER. `splitInvitedRole` reads an invite's single
 * role as either an account role or the module role its grants take.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import { PLATFORM_ROLE, type AccountRole, type ModuleRole } from '@aquaculture/shared-contracts';

const ACCOUNT_ROLE_COLUMN = Object.freeze({
  SUPER_ADMIN: Role.SUPER_ADMIN,
  TENANT_ADMIN: Role.TENANT_ADMIN,
} as const satisfies { readonly [R in AccountRole]: Role });

export function usersRoleColumn(accountRole: AccountRole | null): Role {
  return accountRole === null ? Role.MODULE_USER : ACCOUNT_ROLE_COLUMN[accountRole];
}

export type InvitedRole =
  | { readonly kind: 'account'; readonly accountRole: AccountRole }
  | { readonly kind: 'member'; readonly moduleRole: ModuleRole };

export function splitInvitedRole(invited: Role): InvitedRole {
  switch (invited) {
    case Role.SUPER_ADMIN:
      return { kind: 'account', accountRole: PLATFORM_ROLE.SUPER_ADMIN };
    case Role.TENANT_ADMIN:
      return { kind: 'account', accountRole: PLATFORM_ROLE.TENANT_ADMIN };
    case Role.MODULE_MANAGER:
      return { kind: 'member', moduleRole: PLATFORM_ROLE.MODULE_MANAGER };
    case Role.MODULE_USER:
      return { kind: 'member', moduleRole: PLATFORM_ROLE.MODULE_USER };
  }
}
