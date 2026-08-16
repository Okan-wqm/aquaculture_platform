/**
 * User management domain types
 */

import type { AdminApiRouteResponse } from './generated/admin-route-contracts';
import type { InvitableRoleCode, Role } from '@platform/identity';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
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

export type UserStats = AdminApiRouteResponse<'GET /users/stats'>;

export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: Role;
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
  invitedBy: string;
}

export type Permission = AdminApiRouteResponse<'GET /users/roles/permissions'>[number];

export type RoleTemplate = AdminApiRouteResponse<'GET /users/roles/templates'>[number];

export type RoleHierarchyItem = AdminApiRouteResponse<'GET /users/roles/hierarchy'>[number];

export interface UserLimitCheckResult {
  canCreate: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  message?: string;
}
