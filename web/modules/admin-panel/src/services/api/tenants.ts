/**
 * Tenants API
 */

import { apiFetch } from '../http-client';
import type {
  StandardPaginatedResult,
  TenantSummaryDto,
  TenantListItemDto,
  TenantPublicSummaryDto,
  BulkTenantOperationResult,
  TenantDetailDto,
  TenantStatsDto,
  TenantUsageDto,
  TenantActivityDto,
  TenantNoteDto,
  CreateTenantDto,
  CreateTenantAcceptedResponse,
  UpdateTenantDto,
} from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';
import { decodeAdminSameOriginUrl } from '../browser-capabilities';

const provisioningOperationIdFromStatusUrl = (statusUrl: string): string => {
  const parsed = decodeAdminSameOriginUrl(statusUrl);

  const endpoint = parsed.pathname;

  if (!/^\/tenants\/provisioning\/[0-9a-f-]{36}$/i.test(endpoint)) {
    throw new Error('Provisioning status URL is not an allowed tenant provisioning endpoint');
  }

  const operationId = endpoint.split('/').at(-1);
  if (!operationId) {
    throw new Error('Provisioning status URL has no operation identifier');
  }
  return operationId;
};

type TenantListQuery = AdminApiRouteQuery<'GET /admin/tenants'>;
export type CreateTenantNoteInput = AdminApiRouteBody<'POST /admin/tenants/:id/notes'>;
export type UpdateTenantNoteInput = AdminApiRouteBody<'PATCH /admin/tenants/:id/notes/:noteId'>;
export type CreateTenantInput = AdminApiRouteBody<'POST /tenants'>;
export type UpdateTenantInput = AdminApiRouteBody<'PUT /admin/tenants/:id'>;

export const tenantsApi = {
  list: (params: TenantListQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants'], { query: params }),
  getById: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/:id'], { path: { id: id } }),
  getDetail: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/:id/detail'], { path: { id: id } }),
  getBySlug: (slug: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/lookup/slug/:slug'], { path: { slug: slug } }),
  getStats: () => apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/stats']),
  getUsage: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/:id/usage'], { path: { id: id } }),
  getActivities: (id: string, page?: number, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/:id/activities'], {
      path: { id: id },
      query: { page: page || 1, limit: limit || 20 },
    }),
  getNotes: (id: string, category?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/:id/notes'], {
      path: { id: id },
      query: { category },
    }),
  createNote: (id: string, data: CreateTenantNoteInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /admin/tenants/:id/notes'], { path: { id: id }, body: data }),
  updateNote: (
    tenantId: string,
    noteId: string,
    data: UpdateTenantNoteInput,
  ) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /admin/tenants/:id/notes/:noteId'], {
      path: { id: tenantId, noteId: noteId },
      body: data,
    }),
  deleteNote: (tenantId: string, noteId: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /admin/tenants/:id/notes/:noteId'], {
      path: { id: tenantId, noteId: noteId },
    }),
  create: (data: CreateTenantInput, idempotencyKey: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /tenants'], {
      headers: { 'idempotency-key': idempotencyKey },
      body: data,
    }),
  getProvisioningOperation: (operationId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /tenants/provisioning/:operationId'], {
      path: { operationId: operationId },
    }),
  getProvisioningOperationByStatusUrl: (
    statusUrl: string,
    options?: { readonly signal?: AbortSignal },
  ) =>
    apiFetch(ADMIN_API_ROUTES['GET /tenants/provisioning/:operationId'], {
      path: { operationId: provisioningOperationIdFromStatusUrl(statusUrl) },
      signal: options?.signal,
    }),
  retryProvisioningOperation: (statusUrl: string) => {
    const operationId = provisioningOperationIdFromStatusUrl(statusUrl);
    return apiFetch(ADMIN_API_ROUTES['POST /tenants/provisioning/:operationId/retry'], {
      path: { operationId: operationId },
    });
  },
  update: (id: string, data: UpdateTenantInput) =>
    apiFetch(ADMIN_API_ROUTES['PUT /admin/tenants/:id'], { path: { id: id }, body: data }),
  suspend: (id: string, reason: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /admin/tenants/:id/suspend'], {
      path: { id: id },
      body: { reason },
    }),
  activate: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /admin/tenants/:id/activate'], { path: { id: id } }),
  deactivate: (id: string, reason: string) =>
    apiFetch(ADMIN_API_ROUTES['PATCH /admin/tenants/:id/deactivate'], {
      path: { id: id },
      body: { reason },
    }),
  archive: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /admin/tenants/:id'], { path: { id: id } }),
  search: (q: string, limit?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/search'], {
      query: { q: q, limit: limit || 20 },
    }),
  getApproachingLimits: (threshold?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/approaching-limits'], {
      query: { threshold: threshold || 80 },
    }),
  getExpiringTrials: (withinDays?: number) =>
    apiFetch(ADMIN_API_ROUTES['GET /admin/tenants/expiring-trials'], {
      query: { withinDays: withinDays || 7 },
    }),
  bulkSuspend: (tenantIds: string[], reason: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /admin/tenants/bulk/suspend'], { body: { tenantIds, reason } }),
  bulkActivate: (tenantIds: string[]) =>
    apiFetch(ADMIN_API_ROUTES['POST /admin/tenants/bulk/activate'], { body: { tenantIds } }),
};
