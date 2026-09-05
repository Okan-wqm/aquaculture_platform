/**
 * Tenants API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  Tenant,
  TenantDetail,
  TenantStats,
  TenantActivity,
  TenantNote,
  CreateTenantDto,
  CreateTenantAcceptedResponse,
  UpdateTenantDto,
} from '../types';

const normalizeProvisioningStatusUrl = (statusUrl: string): string => {
  const base =
    typeof window === 'undefined'
      ? 'http://admin-panel.local'
      : window.location.origin;
  const parsed = new URL(statusUrl, base);

  if (parsed.origin !== base) {
    throw new Error('Provisioning status URL must be same-origin');
  }

  const endpoint = parsed.pathname;

  if (!/^\/tenants\/provisioning\/[0-9a-f-]{36}$/i.test(endpoint)) {
    throw new Error('Provisioning status URL is not an allowed tenant provisioning endpoint');
  }

  return `${endpoint}${parsed.search}`;
};

export const tenantsApi = {
  list: (params?: { status?: string; tier?: string; search?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<Tenant>>(`/admin/tenants?${buildQueryString(params || {})}`),
  getById: (id: string) => apiFetch<Tenant>(`/admin/tenants/${id}`),
  getDetail: (id: string) => apiFetch<TenantDetail>(`/admin/tenants/${id}/detail`),
  getBySlug: (slug: string) => apiFetch<Tenant>(`/admin/tenants/slug/${slug}`),
  getStats: () => apiFetch<TenantStats>('/admin/tenants/stats'),
  getUsage: (id: string) => apiFetch<Record<string, unknown>>(`/admin/tenants/${id}/usage`),
  getActivities: (id: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<TenantActivity>>(`/admin/tenants/${id}/activities?page=${page || 1}&limit=${limit || 20}`),
  getNotes: (id: string, category?: string) =>
    apiFetch<TenantNote[]>(`/admin/tenants/${id}/notes${category ? `?category=${category}` : ''}`),
  createNote: (id: string, data: { content: string; category?: string; isPinned?: boolean }) =>
    apiFetch<TenantNote>(`/admin/tenants/${id}/notes`, { method: 'POST', body: JSON.stringify(data) }),
  updateNote: (tenantId: string, noteId: string, data: { content?: string; isPinned?: boolean; category?: string }) =>
    apiFetch<TenantNote>(`/admin/tenants/${tenantId}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNote: (tenantId: string, noteId: string) =>
    apiFetch<void>(`/admin/tenants/${tenantId}/notes/${noteId}`, { method: 'DELETE' }),
  create: (data: CreateTenantDto, idempotencyKey?: string) =>
    apiFetch<CreateTenantAcceptedResponse>('/tenants', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  getProvisioningOperation: (operationId: string) =>
    apiFetch<CreateTenantAcceptedResponse>(`/tenants/provisioning/${operationId}`),
  getProvisioningOperationByStatusUrl: (statusUrl: string, options?: RequestInit) =>
    apiFetch<CreateTenantAcceptedResponse>(normalizeProvisioningStatusUrl(statusUrl), options),
  retryProvisioningOperation: (statusUrl: string) => {
    const [endpoint] = normalizeProvisioningStatusUrl(statusUrl).split('?');
    return apiFetch<CreateTenantAcceptedResponse>(`${endpoint}/retry`, { method: 'POST' });
  },
  update: (id: string, data: UpdateTenantDto) =>
    apiFetch<Tenant>(`/admin/tenants/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  suspend: (id: string, reason: string) =>
    apiFetch<Tenant>(`/admin/tenants/${id}/suspend`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  activate: (id: string) => apiFetch<Tenant>(`/admin/tenants/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string, reason: string) =>
    apiFetch<Tenant>(`/admin/tenants/${id}/deactivate`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  archive: (id: string) => apiFetch<void>(`/admin/tenants/${id}`, { method: 'DELETE' }),
  search: (q: string, limit?: number) =>
    apiFetch<Tenant[]>(`/admin/tenants/search?q=${encodeURIComponent(q)}&limit=${limit || 20}`),
  getExpiringTrials: (withinDays?: number) =>
    apiFetch<Tenant[]>(`/admin/tenants/expiring-trials?withinDays=${withinDays || 7}`),
  bulkSuspend: (tenantIds: string[], reason: string) =>
    apiFetch<{ success: string[]; failed: string[] }>('/admin/tenants/bulk/suspend', {
      method: 'POST',
      body: JSON.stringify({ tenantIds, reason }),
    }),
  bulkActivate: (tenantIds: string[]) =>
    apiFetch<{ success: string[]; failed: string[] }>('/admin/tenants/bulk/activate', {
      method: 'POST',
      body: JSON.stringify({ tenantIds }),
    }),
};
