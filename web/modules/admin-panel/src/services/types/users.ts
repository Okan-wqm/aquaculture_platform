/**
 * User management domain types
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import {
  PLATFORM_ROLE_CODES,
  INVITABLE_ROLE_CODES,
} from './generated/admin-contracts';
import type {
  UserStats,
  Permission,
  RoleTemplate,
  UserDto,
  PlatformRoleCode,
  InvitableRoleCode,
} from './generated/admin-contracts';

export type {
  UserStats,
  Permission,
  RoleTemplate,
  UserDto,
};

/**
 * The canonical role vocabulary, GENERATED from
 * `libs/event-contracts/src/roles.ts`.
 *
 * The panel used to mirror both arrays by hand, held member-for-member to the
 * backend by `tests/invariants/rbac-vocabulary-ssot.spec.ts`. Codegen removes
 * the copy that spec existed to police — the array form generates the same way
 * a string enum does, so a vocabulary declared `as const` is no longer a reason
 * to hand-write one.
 *
 * `PLATFORM_ROLES` and `PlatformRole` stay as the panel's names for them so no
 * call site changes; they are aliases, not declarations.
 */
export { PLATFORM_ROLE_CODES as PLATFORM_ROLES, INVITABLE_ROLE_CODES };
export type { PlatformRoleCode as PlatformRole, InvitableRoleCode as InvitableRole };

/** Human-readable label for each platform role. */
export const ROLE_LABELS: Record<PlatformRoleCode, string> = {
  SUPER_ADMIN: 'Super Admin',
  TENANT_ADMIN: 'Tenant Admin',
  MODULE_MANAGER: 'Module Manager',
  MODULE_USER: 'Module User',
};

/**
 * A user as the panel reads it — an alias of the generated `UserDto`.
 *
 * The hand-written version declared five fields the `listUsers` SELECT has never
 * returned (`isEmailVerified`, `profileImageUrl`, `phoneNumber`,
 * `preferredLanguage`, `mfaEnabled`) and carried `[key: string]: unknown`, an
 * index signature that made any property read compile — which is exactly why
 * nobody noticed the five.
 */
export type User = UserDto;

export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: PlatformRoleCode;
  tenantId?: string;
}

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: InvitableRoleCode;
  moduleIds?: string[];
  primaryModuleId?: string;
  message?: string;
}

export interface RoleHierarchyItem {
  code: string;
  name: string;
  description: string;
  level: number;
  permissions: string[];
  isSystem: boolean;
  color: string;
  icon: string;
  userCount?: number;
  children?: RoleHierarchyItem[];
}

export interface UserLimitCheckResult {
  canCreate: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  message?: string;
}
