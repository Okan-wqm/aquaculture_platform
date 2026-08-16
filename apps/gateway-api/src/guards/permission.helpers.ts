/**
 * Permission Helper Functions
 *
 * Standalone utility functions for checking user permissions and roles
 * outside of the NestJS guard context. Extracted from permission.guard.ts
 * to keep the guard file under the 500-line limit.
 */

import { JwtPayload } from '../types/index';
import { implicitPermissionsForRole } from '@platform/identity';
import { ROLE_HIERARCHY } from './permission.guard';

/**
 * Check if a user has a specific permission.
 * Evaluates exact match, wildcard patterns, and role-based permissions.
 *
 * @param user - The JWT payload containing user roles and permissions
 * @param permission - The permission string to check (e.g., 'sensors:read')
 * @returns true if the user has the requested permission
 */
export function userHasPermission(user: JwtPayload, permission: string): boolean {
  const permissions = user.permissions || [];

  // Check wildcard
  if (permissions.includes('*')) {
    return true;
  }

  // Check exact match
  if (permissions.includes(permission)) {
    return true;
  }

  // Check resource wildcard
  const [resource] = permission.split(':');
  if (permissions.includes(`${resource}:*`) || permissions.includes(`${resource}:manage`)) {
    return true;
  }

  // Check role-based permissions
  for (const role of user.roles) {
    const rolePerms = implicitPermissionsForRole(role);
    if (rolePerms.includes('*') || rolePerms.includes(permission)) {
      return true;
    }
    if (rolePerms.includes(`${resource}:*`) || rolePerms.includes(`${resource}:manage`)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a user has a specific role, including inherited roles.
 *
 * @param user - The JWT payload containing user roles
 * @param role - The role to check
 * @returns true if the user has the role directly or via hierarchy
 */
export function userHasRole(user: JwtPayload, role: string): boolean {
  if (user.roles.includes(role)) {
    return true;
  }

  // Check role hierarchy
  for (const userRole of user.roles) {
    const inheritedRoles = ROLE_HIERARCHY[userRole] || [];
    if (inheritedRoles.includes(role)) {
      return true;
    }
  }

  return false;
}
