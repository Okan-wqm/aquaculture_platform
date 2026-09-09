/**
 * Users API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  User,
  UserStats,
  CreateUserDto,
  InviteUserDto,
  Permission,
  RoleTemplate,
  RoleHierarchyItem,
  UserLimitCheckResult,
} from '../types';

export const usersApi = {
  list: (
    params?: {
      tenantId?: string;
      role?: string;
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
    signal?: AbortSignal,
  ) => apiFetch<PaginatedResult<User>>(`/users?${buildQueryString(params || {})}`, { signal }),
  getById: (id: string) => apiFetch<User>(`/users/${id}`),
  getStats: (signal?: AbortSignal) => apiFetch<UserStats>('/users/stats', { signal }),
  getByTenant: (tenantId: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<User>>(`/users/by-tenant/${tenantId}?page=${page || 1}&limit=${limit || 20}`),
  getRecentActivity: (limit?: number) => apiFetch<User[]>(`/users/recent-activity?limit=${limit || 50}`),
  getUserActivity: (userId: string, limit?: number) =>
    apiFetch<unknown[]>(`/users/${userId}/activity?limit=${limit || 50}`),
  getUserSessions: (userId: string) => apiFetch<unknown[]>(`/users/${userId}/sessions`),
  create: (data: CreateUserDto) =>
    apiFetch<User>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<CreateUserDto & { isActive?: boolean }>) =>
    apiFetch<User>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  activate: (id: string) => apiFetch<User>(`/users/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string) => apiFetch<User>(`/users/${id}/deactivate`, { method: 'PATCH' }),
  resetPassword: (id: string, newPassword: string) =>
    apiFetch<{ success: boolean }>(`/users/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ newPassword }) }),
  forceLogout: (id: string) => apiFetch<{ success: boolean; count: number }>(`/users/${id}/force-logout`, { method: 'PATCH' }),
  delete: (id: string) => apiFetch<void>(`/users/${id}`, { method: 'DELETE' }),
  invite: (data: InviteUserDto) =>
    apiFetch<{ success: boolean; userId: string; invitationId: string }>('/users/invite', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  checkTenantLimit: (tenantId: string) =>
    apiFetch<UserLimitCheckResult>(`/users/tenant/${tenantId}/limit`),
  getRoleTemplates: (signal?: AbortSignal) =>
    apiFetch<RoleTemplate[]>('/users/roles/templates', { signal }),
  getAssignableRoles: (roleCode: string) =>
    apiFetch<RoleTemplate[]>(`/users/roles/assignable/${roleCode}`),
  getPermissions: () => apiFetch<Permission[]>('/users/roles/permissions'),
  getPermissionsByCategory: (signal?: AbortSignal) =>
    apiFetch<Record<string, Permission[]>>('/users/roles/permissions/grouped', { signal }),
  getRoleHierarchy: (signal?: AbortSignal) =>
    apiFetch<RoleHierarchyItem[]>('/users/roles/hierarchy', { signal }),
  canAssignRole: (assignerRole: string, targetRole: string) =>
    apiFetch<{ allowed: boolean; reason?: string }>(`/users/roles/can-assign?assignerRole=${assignerRole}&targetRole=${targetRole}`),
  getRolePermissions: (roleCode: string, signal?: AbortSignal) =>
    apiFetch<string[]>(`/users/roles/${roleCode}/permissions`, { signal }),
};
