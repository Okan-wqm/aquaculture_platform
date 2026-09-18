/**
 * User management domain types
 */

import type { ApiSchema } from '../contract';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: PlatformRole;
  tenantId: string | null;
  tenantName: string | null;
  isActive: boolean;
  isEmailVerified?: boolean;
  // Profile fields
  profileImageUrl?: string | null;
  phoneNumber?: string | null;
  preferredLanguage?: string | null;
  // Security fields
  mfaEnabled?: boolean;
  // Timestamps
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  usersByRole: Array<{ role: string; count: number }>;
  usersByTenant: Array<{ tenantId: string; tenantName: string; count: number }>;
  newUsersLast30Days: number;
  loginsLast24Hours: number;
}

/** Generated from the backend contract (CONTRACT-CRITICAL-003). */
export type CreateUserDto = ApiSchema<'CreateUserDto'>;

/**
 * The platform's role vocabulary, as the contract declares it.
 *
 * Four hand-typed copies of this list had drifted apart — admin-api's DTOs
 * named `MANAGER`/`OPERATOR`/`VIEWER`, its role catalogue published
 * `SUPERVISOR` and `OPERATOR`, and this module's forms typed `role` as a bare
 * `string` so none of it was checkable (ADMIN-CRITICAL-133). Sourced from the
 * generated contract, a role the server does not accept is a compile error in
 * the form that offers it.
 */
export const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
  'MODULE_USER',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * The contract is the authority, and this proves the runtime list above still
 * equals it — in BOTH directions, so neither a role added on the server nor one
 * invented here can pass. A `<select>` hands back a `string`, so the list has to
 * exist at runtime for `isPlatformRole` to narrow it; this assertion is what
 * stops that list from becoming a fifth hand-typed copy.
 */
type RolesMatchContract = [PlatformRole] extends [NonNullable<CreateUserDto['role']>]
  ? [NonNullable<CreateUserDto['role']>] extends [PlatformRole]
    ? true
    : never
  : never;
const ROLES_MATCH_CONTRACT: RolesMatchContract = true;
void ROLES_MATCH_CONTRACT;

/** Narrow a `<select>` value — or any string off the wire — to a platform role. */
export const isPlatformRole = (value: string): value is PlatformRole =>
  (PLATFORM_ROLES as readonly string[]).includes(value);

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: PlatformRole;
  moduleIds?: string[];
  primaryModuleId?: string;
  message?: string;
  /**
   * NOT SENT. The inviter is taken from the authenticated principal on the
   * server (`req.user.id`), which is the only value that can be trusted —
   * a client-supplied actor on an audited action is forgeable.
   *
   * This field was declared REQUIRED here, so the one caller invented
   * `invitedBy: 'system'` to satisfy the compiler and sent it. The server's
   * `InviteUserRequestDto` does not declare it, and admin-api runs
   * `ValidationPipe({ forbidNonWhitelisted: true })` — so every invitation the
   * admin panel has ever sent was rejected with a 400 before reaching a
   * handler (ADMIN-CRITICAL-133).
   */
  invitedBy?: never;
}

export interface Permission {
  code: string;
  name: string;
  description: string;
  category: string;
}

export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  level: number;
  permissions: string[];
  isSystem: boolean;
  color: string;
  icon: string;
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
