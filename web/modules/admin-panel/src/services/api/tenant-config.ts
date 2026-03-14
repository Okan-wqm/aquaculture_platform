/**
 * Tenant Configuration API
 *
 * Tenant-specific configuration, API key management, and webhook endpoints.
 * Extracted from settings.ts for single-responsibility.
 */

import { apiFetch } from '../http-client';
import type { TenantConfiguration } from '../types';

export const tenantConfigApi = {
  getTenantConfig: (tenantId: string) => apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}`),
  updateTenantConfig: (tenantId: string, config: Partial<TenantConfiguration>) =>
    apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}`, { method: 'PUT', body: JSON.stringify(config) }),
  createTenantApiKey: (tenantId: string, data: { name: string; scopes: string[]; expiresAt?: string }) =>
    apiFetch<{ apiKey: string; id: string }>(`/settings/tenant/${tenantId}/api-keys`, { method: 'POST', body: JSON.stringify(data) }),
  revokeTenantApiKey: (tenantId: string, keyId: string) =>
    apiFetch<void>(`/settings/tenant/${tenantId}/api-keys/${keyId}`, { method: 'DELETE' }),
  createWebhook: (tenantId: string, data: { url: string; events: string[] }) =>
    apiFetch<{ id: string; secret: string }>(`/settings/tenant/${tenantId}/webhooks`, { method: 'POST', body: JSON.stringify(data) }),
  deleteWebhook: (tenantId: string, webhookId: string) =>
    apiFetch<void>(`/settings/tenant/${tenantId}/webhooks/${webhookId}`, { method: 'DELETE' }),
  testWebhook: (tenantId: string, webhookId: string) =>
    apiFetch<{ success: boolean; statusCode: number; responseTime: number }>(`/settings/tenant/${tenantId}/webhooks/${webhookId}/test`, { method: 'POST' }),
};
