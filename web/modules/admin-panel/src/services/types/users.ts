/**
 * User management domain types
 */

/**
 * Canonical platform role vocabulary — PINNED mirror of the backend SSoT
 * (`PLATFORM_ROLE_CODES` in `@platform/event-contracts/roles`, itself pinned to
 * the `Role` enum). Web modules cannot import backend libraries, so this literal
 * is the single FE definition site for role codes and is held member-for-member
 * equal to the backend set by `tests/invariants/rbac-vocabulary-ssot.spec.ts`
 * (APA-050). Every FE role dropdown/option list derives from here — no inline
 * role-string arrays elsewhere.
 */
export const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
  'MODULE_USER',
] as const;

/** Union of the canonical platform role codes. */
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * Roles assignable through the tenant-scoped invite flow. `SUPER_ADMIN` is
 * platform-level and never invitable via a tenant admin surface.
 */
export type InvitableRole = Exclude<PlatformRole, 'SUPER_ADMIN'>;

/** Human-readable label for each platform role. */
export const ROLE_LABELS: Record<PlatformRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  TENANT_ADMIN: 'Tenant Admin',
  MODULE_MANAGER: 'Module Manager',
  MODULE_USER: 'Module User',
};

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

export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: PlatformRole;
  tenantId?: string;
}

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: InvitableRole;
  moduleIds?: string[];
  primaryModuleId?: string;
  message?: string;
}

export interface Permission {
  code: string;
  name: string;
  description: string;
  category: string;
}

export interface RoleTemplate {
  code: PlatformRole;
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
