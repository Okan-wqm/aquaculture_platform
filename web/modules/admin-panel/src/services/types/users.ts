/**
 * User management domain types
 */

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
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
  role: string;
  tenantId?: string;
}

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  moduleIds?: string[];
  primaryModuleId?: string;
  message?: string;
  invitedBy: string;
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
