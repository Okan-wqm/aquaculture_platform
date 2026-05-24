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

export const tenantsApi = {
  list: (params?: { status?: string; tier?: string; search?: string; page?: number; limit?: number }) =>
    apiFetch<PaginatedResult<Tenant>>(`/tenants?${buildQueryString(params || {})}`),
  getById: (id: string) => apiFetch<Tenant>(`/tenants/${id}`),
  getDetail: (id: string) => apiFetch<TenantDetail>(`/tenants/${id}/detail`),
  getBySlug: (slug: string) => apiFetch<Tenant>(`/tenants/slug/${slug}`),
  getStats: () => apiFetch<TenantStats>('/tenants/stats'),
  getUsage: (id: string) => apiFetch<Record<string, unknown>>(`/tenants/${id}/usage`),
  getActivities: (id: string, page?: number, limit?: number) =>
    apiFetch<PaginatedResult<TenantActivity>>(`/tenants/${id}/activities?page=${page || 1}&limit=${limit || 20}`),
  getNotes: (id: string, category?: string) =>
    apiFetch<TenantNote[]>(`/tenants/${id}/notes${category ? `?category=${category}` : ''}`),
  createNote: (id: string, data: { content: string; category?: string; isPinned?: boolean }) =>
    apiFetch<TenantNote>(`/tenants/${id}/notes`, { method: 'POST', body: JSON.stringify(data) }),
  updateNote: (tenantId: string, noteId: string, data: { content?: string; isPinned?: boolean; category?: string }) =>
    apiFetch<TenantNote>(`/tenants/${tenantId}/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNote: (tenantId: string, noteId: string) =>
    apiFetch<void>(`/tenants/${tenantId}/notes/${noteId}`, { method: 'DELETE' }),
  create: (data: CreateTenantDto, idempotencyKey?: string) =>
    apiFetch<CreateTenantAcceptedResponse>('/tenants', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  getProvisioningOperation: (operationId: string) =>
    apiFetch<CreateTenantAcceptedResponse>(`/tenants/provisioning/${operationId}`),
  retryProvisioningOperation: (operationId: string) =>
    apiFetch<CreateTenantAcceptedResponse>(`/tenants/provisioning/${operationId}/retry`, { method: 'POST' }),
  update: (id: string, data: UpdateTenantDto) =>
    apiFetch<Tenant>(`/tenants/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  suspend: (id: string, reason: string) =>
    apiFetch<Tenant>(`/tenants/${id}/suspend`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  activate: (id: string) => apiFetch<Tenant>(`/tenants/${id}/activate`, { method: 'PATCH' }),
  deactivate: (id: string, reason: string) =>
    apiFetch<Tenant>(`/tenants/${id}/deactivate`, { method: 'PATCH', body: JSON.stringify({ reason }) }),
  archive: (id: string) => apiFetch<void>(`/tenants/${id}`, { method: 'DELETE' }),
  search: (q: string, limit?: number) =>
    apiFetch<Tenant[]>(`/tenants/search?q=${encodeURIComponent(q)}&limit=${limit || 20}`),
  getApproachingLimits: (threshold?: number) =>
    apiFetch<Tenant[]>(`/tenants/approaching-limits?threshold=${threshold || 80}`),
  getExpiringTrials: (withinDays?: number) =>
    apiFetch<Tenant[]>(`/tenants/expiring-trials?withinDays=${withinDays || 7}`),
  bulkSuspend: (tenantIds: string[], reason: string) =>
    apiFetch<{ success: string[]; failed: string[] }>('/tenants/bulk/suspend', {
      method: 'POST',
      body: JSON.stringify({ tenantIds, reason }),
    }),
  bulkActivate: (tenantIds: string[]) =>
    apiFetch<{ success: string[]; failed: string[] }>('/tenants/bulk/activate', {
      method: 'POST',
      body: JSON.stringify({ tenantIds }),
    }),
};
