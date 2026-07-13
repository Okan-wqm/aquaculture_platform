/**
 * Modules API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  SystemModule,
  ModuleStats,
  TenantModuleAssignment,
  ModuleQuantities,
} from '../types';

export const modulesApi = {
  list: (params?: { isActive?: boolean; isCore?: boolean; search?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<SystemModule>>(`/modules?${buildQueryString(params || {})}`),
  getById: (id: string) => apiFetch<SystemModule>(`/modules/${id}`),
  getByCode: (code: string) => apiFetch<SystemModule>(`/modules/code/${code}`),
  getStats: () => apiFetch<ModuleStats>('/modules/stats'),
  getModuleTenants: (moduleId: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<unknown>>(`/modules/${moduleId}/tenants?page=${page || 1}&limit=${limit || 50}`),
  getAllAssignments: (params?: { tenantId?: string; moduleId?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<TenantModuleAssignment>>(`/modules/assignments?${buildQueryString(params || {})}`),
  // WHY no price on create/update: billing owns pricing (D14). Per-module
  // prices are managed via the module-pricing catalog (billingApi's
  // /billing/module-pricing endpoints backed by admin.module_pricing);
  // SystemModule.price is read-only, derived from that catalog.
  create: (data: { code: string; name: string; description?: string; defaultRoute: string; icon?: string; isCore?: boolean }) =>
    apiFetch<SystemModule>('/modules', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<{ name: string; description: string; defaultRoute: string; icon: string; isActive: boolean }>) =>
    apiFetch<SystemModule>(`/modules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  activate: (id: string) => apiFetch<SystemModule>(`/modules/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string) => apiFetch<SystemModule>(`/modules/${id}/deactivate`, { method: 'PATCH' }),
  delete: (id: string) => apiFetch<void>(`/modules/${id}`, { method: 'DELETE' }),
  assignToTenant: (tenantId: string, moduleId: string, options?: { quantities?: ModuleQuantities; configuration?: Record<string, unknown>; expiresAt?: string }) =>
    apiFetch<TenantModuleAssignment>('/modules/assignments', {
      method: 'POST',
      body: JSON.stringify({
        tenantId,
        moduleId,
        quantities: options?.quantities,
        configuration: options?.configuration,
        expiresAt: options?.expiresAt,
      }),
    }),
  removeFromTenant: (tenantId: string, moduleId: string) =>
    apiFetch<void>(`/modules/assignments/${tenantId}/${moduleId}`, { method: 'DELETE' }),
};
