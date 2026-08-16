/**
 * Users API
 */

import { apiFetch } from '../http-client';
import type {
  StandardPaginatedResult,
  User,
  UserStats,
  CreateUserDto,
  InviteUserDto,
  Permission,
  RoleTemplate,
  RoleHierarchyItem,
  UserLimitCheckResult,
} from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type UsersQuery = AdminApiRouteQuery<'GET /users'>;

export const usersApi = {
  list: (params: UsersQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /users'], { query: params }),
  getById: (id: string) => apiFetch(ADMIN_API_ROUTES['GET /users/:id'], { path: { id: id } }),
  getStats: () => apiFetch(ADMIN_API_ROUTES['GET /users/stats']),
  getByTenant: (tenantId: string, page?: number, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/lookup/tenant/:tenantId'], {
      path: { tenantId: tenantId },
      query: { page: page || 1, limit: limit || 20 },
    }),
  getRecentActivity: (limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/recent-activity'], { query: { limit: limit || 50 } }),
  getUserActivity: (userId: string, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/:id/activity'], {
      path: { id: userId },
      query: { limit: limit || 50 },
    }),
  getUserSessions: (userId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/:id/sessions'], { path: { id: userId } }),
  create: (data: CreateUserDto) => apiFetch(ADMIN_API_ROUTES['POST /users'], { body: data }),
  update: (id: string, data: Partial<CreateUserDto & { isActive?: boolean }>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /users/:id'], { path: { id: id }, body: data }),
  activate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /users/:id/activate'], { path: { id: id } }),
  deactivate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /users/:id/deactivate'], { path: { id: id } }),
  resetPassword: (id: string, newPassword: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /users/:id/reset-password'], {
      path: { id: id },
      body: { newPassword },
    }),
  forceLogout: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /users/:id/force-logout'], { path: { id: id } }),
  delete: (id: string) => apiFetch(ADMIN_API_ROUTES['DELETE /users/:id'], { path: { id: id } }),
  invite: (data: InviteUserDto) => apiFetch(ADMIN_API_ROUTES['POST /users/invite'], { body: data }),
  checkTenantLimit: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/tenant/:tenantId/limit'], {
      path: { tenantId: tenantId },
    }),
  getRoleTemplates: () => apiFetch(ADMIN_API_ROUTES['GET /users/roles/templates']),
  getAssignableRoles: (roleCode: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/roles/lookup/:roleCode/assignable'], {
      path: { roleCode: roleCode },
    }),
  getPermissions: () => apiFetch(ADMIN_API_ROUTES['GET /users/roles/permissions']),
  getPermissionsByCategory: () =>
    apiFetch(ADMIN_API_ROUTES['GET /users/roles/permissions/grouped']),
  getRoleHierarchy: () => apiFetch(ADMIN_API_ROUTES['GET /users/roles/hierarchy']),
  canAssignRole: (assignerRole: string, targetRole: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/roles/can-assign'], {
      query: { assignerRole: assignerRole, targetRole: targetRole },
    }),
  getRolePermissions: (roleCode: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /users/roles/:roleCode/permissions'], {
      path: { roleCode: roleCode },
    }),
};
