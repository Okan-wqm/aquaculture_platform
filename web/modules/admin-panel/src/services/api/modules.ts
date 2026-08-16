/**
 * Modules API
 */

import { apiFetch } from '../http-client';
import type {
  StandardPaginatedResult,
  SystemModule,
  ModuleStats,
  TenantModuleAssignment,
  ModuleQuantities,
} from '../types';
import { ADMIN_API_ROUTES } from '../types/generated/admin-route-contracts';

export const modulesApi = {
  list: (params?: {
    isActive?: boolean;
    isCore?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }) => apiFetch(ADMIN_API_ROUTES['GET /modules'], { query: params || {} }),
  getById: (id: string) => apiFetch(ADMIN_API_ROUTES['GET /modules/:id'], { path: { id: id } }),
  getByCode: (code: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /modules/lookup/code/:code'], { path: { code: code } }),
  getStats: () => apiFetch(ADMIN_API_ROUTES['GET /modules/stats']),
  getModuleTenants: (moduleId: string, page?: number, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /modules/:id/tenants'], {
      path: { id: moduleId },
      query: { page: page || 1, limit: limit || 50 },
    }),
  getAllAssignments: (params?: {
    tenantId?: string;
    moduleId?: string;
    page?: number;
    limit?: number;
  }) => apiFetch(ADMIN_API_ROUTES['GET /modules/assignments'], { query: params || {} }),
  // WHY no price on create/update: billing owns pricing (D14). Per-module
  // prices are managed via the module-pricing catalog (billingApi's
  // /billing/module-pricing endpoints backed by admin.module_pricing);
  // SystemModule.price is read-only, derived from that catalog.
  create: (data: {
    code: string;
    name: string;
    description?: string;
    defaultRoute: string;
    icon?: string;
    isCore?: boolean;
  }) => apiFetch(ADMIN_API_ROUTES['POST /modules'], { body: data }),
  update: (
    id: string,
    data: Partial<{
      name: string;
      description: string;
      defaultRoute: string;
      icon: string;
      isActive: boolean;
    }>,
  ) => apiFetch(ADMIN_API_ROUTES['PUT /modules/:id'], { path: { id: id }, body: data }),
  activate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /modules/:id/activate'], { path: { id: id } }),
  deactivate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /modules/:id/deactivate'], { path: { id: id } }),
  delete: (id: string) => apiFetch(ADMIN_API_ROUTES['DELETE /modules/:id'], { path: { id: id } }),
  assignToTenant: (
    tenantId: string,
    moduleId: string,
    options?: {
      quantities?: ModuleQuantities;
      configuration?: Record<string, unknown>;
      expiresAt?: string;
    },
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /modules/assignments'], {
      body: {
        tenantId,
        moduleId,
        quantities: options?.quantities,
        configuration: options?.configuration,
        expiresAt: options?.expiresAt,
      },
    }),
  removeFromTenant: (tenantId: string, moduleId: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /modules/assignments/:tenantId/:moduleId'], {
      path: { tenantId: tenantId, moduleId: moduleId },
    }),
};
