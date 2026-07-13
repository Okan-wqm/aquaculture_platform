/**
 * Tenant Configuration API
 *
 * Tenant-specific configuration sub-resource endpoints.
 * Maps to admin-api-service TenantConfigurationController endpoints.
 *
 * Sub-resources: user-limits, storage, api, api-keys, webhooks,
 * domain, branding, security, notifications, features, data-retention
 */

import { apiFetch } from '../http-client';
import type { TenantConfiguration } from '../types';

// ============================================================================
// Sub-resource types (mirror backend entity interfaces)
// ============================================================================

export interface UserLimitsConfig {
  maxUsers: number;
  maxAdmins: number;
  maxModuleManagers: number;
  maxConcurrentSessions: number;
  sessionTimeoutMinutes: number;
  inactiveUserCleanupDays: number;
  allowGuestAccess: boolean;
}

export interface StorageConfig {
  totalStorageGB: number;
  usedStorageGB: number;
  maxFileSizeMB: number;
  allowedFileTypes: string[];
  enableFileVersioning: boolean;
  versionRetentionCount: number;
  compressionEnabled: boolean;
}

export interface ApiConfig {
  enabled: boolean;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  rateLimitPerDay: number;
  maxConcurrentRequests: number;
  apiKeys: ApiKeyConfig[];
  webhooksEnabled: boolean;
  webhookRetryCount: number;
  ipWhitelist: string[];
}

export interface ApiKeyConfig {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  createdBy: string;
  isActive: boolean;
}

export interface DataRetentionConfig {
  auditLogRetentionDays: number;
  activityLogRetentionDays: number;
  sensorDataRetentionDays: number;
  alertHistoryRetentionDays: number;
  deletedDataRetentionDays: number;
  backupRetentionDays: number;
  autoDeleteEnabled: boolean;
  archiveBeforeDelete: boolean;
}

export interface DomainConfig {
  customDomain?: string;
  customDomainVerified: boolean;
  customDomainVerificationToken?: string;
  subdomain?: string;
  sslCertificateExpiry?: string;
  redirectToCustomDomain: boolean;
  allowedOrigins: string[];
}

export interface BrandingConfig {
  logoUrl?: string;
  faviconUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headerColor: string;
  fontFamily: string;
  companyName: string;
  supportEmail?: string;
  supportPhone?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
  customCss?: string;
  emailHeaderHtml?: string;
  emailFooterHtml?: string;
  loginBackgroundUrl?: string;
  showPoweredBy: boolean;
}

export interface TenantSecurityConfig {
  // ADR-045: `mfaRequired` and `sessionTimeoutMinutes` are deliberately
  // absent — tenant MFA-enforcement and session-timeout policy are owned +
  // enforced by auth-service and managed by the tenant's own admin
  // (tenant-admin module), not by SUPER_ADMIN here.
  mfaRequiredForAdmins: boolean;
  allowedMfaMethods: string[];
  ssoEnabled: boolean;
  ssoProvider?: string;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireNumbers: boolean;
  passwordRequireSpecialChars: boolean;
  passwordExpiryDays: number;
  passwordHistoryCount: number;
  preventCommonPasswords: boolean;
  ipWhitelistEnabled: boolean;
  ipWhitelist: string[];
  ipBlacklistEnabled: boolean;
  ipBlacklist: string[];
  geoBlockingEnabled: boolean;
  allowedCountries: string[];
  blockedCountries: string[];
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  rememberMeDays: number;
  singleSessionPerUser: boolean;
  terminateSessionsOnPasswordChange: boolean;
}

export interface TenantNotificationConfig {
  emailEnabled: boolean;
  emailFromName?: string;
  emailFromAddress?: string;
  customSmtpEnabled: boolean;
  smsEnabled: boolean;
  smsProvider?: string;
  pushEnabled: boolean;
  pushProvider?: string;
  slackEnabled: boolean;
  slackWebhookUrl?: string;
  slackDefaultChannel?: string;
  webhookEnabled: boolean;
  webhooks: WebhookConfig[];
  digestFrequency: string;
  quietHoursEnabled: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursTimezone?: string;
}

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: string[];
  secretEncrypted?: string;
  headers?: Record<string, string>;
  isActive: boolean;
  retryEnabled: boolean;
  retryCount: number;
  lastTriggeredAt?: string;
  lastStatus?: 'success' | 'failed';
  createdAt: string;
}

export interface FeatureFlagsConfig {
  enabledModules: string[];
  advancedAnalytics: boolean;
  customReports: boolean;
  dataExport: boolean;
  dataImport: boolean;
  bulkOperations: boolean;
  auditLog: boolean;
  apiAccess: boolean;
  mobileAccess: boolean;
  offlineMode: boolean;
  thirdPartyIntegrations: boolean;
  customIntegrations: boolean;
  iotDeviceSupport: boolean;
  betaFeatures: string[];
  planOverrides: Record<string, boolean>;
}

// ============================================================================
// API Methods
// ============================================================================

export const tenantConfigApi = {
  // ---------------------------------------------------------------------------
  // Top-level CRUD (backward compatible)
  // ---------------------------------------------------------------------------
  getTenantConfig: (tenantId: string) =>
    apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}`),

  updateTenantConfig: (tenantId: string, config: Partial<TenantConfiguration>) =>
    apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  getOrCreateConfig: (tenantId: string) =>
    apiFetch<TenantConfiguration>(`/settings/tenant/${tenantId}/ensure`),

  getConfigSummary: (tenantId: string) =>
    apiFetch<{
      userLimits: { current: number; max: number };
      storage: { used: number; total: number };
      apiEnabled: boolean;
      apiKeyCount: number;
      webhookCount: number;
      customDomain: string | null;
      enabledModules: string[];
    }>(`/settings/tenant/${tenantId}/summary`),

  // ---------------------------------------------------------------------------
  // User Limits
  // ---------------------------------------------------------------------------
  getUserLimits: (tenantId: string) =>
    apiFetch<UserLimitsConfig>(`/settings/tenant/${tenantId}/user-limits`),

  updateUserLimits: (tenantId: string, limits: Partial<UserLimitsConfig>) =>
    apiFetch<UserLimitsConfig>(`/settings/tenant/${tenantId}/user-limits`, {
      method: 'PUT',
      body: JSON.stringify(limits),
    }),

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  getStorageConfig: (tenantId: string) =>
    apiFetch<StorageConfig>(`/settings/tenant/${tenantId}/storage`),

  updateStorageConfig: (tenantId: string, storage: Partial<StorageConfig>) =>
    apiFetch<StorageConfig>(`/settings/tenant/${tenantId}/storage`, {
      method: 'PUT',
      body: JSON.stringify(storage),
    }),

  checkStorageLimit: (tenantId: string, additionalSizeGB: number) =>
    apiFetch<{ allowed: boolean }>(`/settings/tenant/${tenantId}/storage/check-limit`, {
      method: 'POST',
      body: JSON.stringify({ additionalSizeGB }),
    }),

  // ---------------------------------------------------------------------------
  // API Configuration
  // ---------------------------------------------------------------------------
  getApiConfig: (tenantId: string) =>
    apiFetch<ApiConfig>(`/settings/tenant/${tenantId}/api`),

  updateApiConfig: (tenantId: string, apiConfig: Partial<ApiConfig>) =>
    apiFetch<ApiConfig>(`/settings/tenant/${tenantId}/api`, {
      method: 'PUT',
      body: JSON.stringify(apiConfig),
    }),

  // ---------------------------------------------------------------------------
  // API Keys
  // ---------------------------------------------------------------------------
  createTenantApiKey: (tenantId: string, data: { name: string; scopes: string[]; expiresAt?: string }) =>
    apiFetch<{ apiKey: string; keyConfig: ApiKeyConfig }>(`/settings/tenant/${tenantId}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({
        name: data.name,
        permissions: data.scopes,
        expiresAt: data.expiresAt,
      }),
    }),

  revokeTenantApiKey: (tenantId: string, keyId: string) =>
    apiFetch<void>(`/settings/tenant/${tenantId}/api-keys/${keyId}`, {
      method: 'DELETE',
    }),

  validateApiKey: (tenantId: string, apiKey: string) =>
    apiFetch<{ valid: boolean; key: ApiKeyConfig | null }>(`/settings/tenant/${tenantId}/api-keys/validate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------
  getWebhooks: (tenantId: string) =>
    apiFetch<WebhookConfig[]>(`/settings/tenant/${tenantId}/webhooks`),

  createWebhook: (tenantId: string, data: {
    name: string;
    url: string;
    events: string[];
    secret?: string;
    headers?: Record<string, string>;
    retryEnabled?: boolean;
    retryCount?: number;
  }) =>
    apiFetch<WebhookConfig>(`/settings/tenant/${tenantId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateWebhook: (tenantId: string, webhookId: string, updates: {
    name?: string;
    url?: string;
    events?: string[];
    secret?: string;
    headers?: Record<string, string>;
    retryEnabled?: boolean;
    retryCount?: number;
  }) =>
    apiFetch<WebhookConfig>(`/settings/tenant/${tenantId}/webhooks/${webhookId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  deleteWebhook: (tenantId: string, webhookId: string) =>
    apiFetch<void>(`/settings/tenant/${tenantId}/webhooks/${webhookId}`, {
      method: 'DELETE',
    }),

  // ---------------------------------------------------------------------------
  // Domain & Branding
  // ---------------------------------------------------------------------------
  getDomainConfig: (tenantId: string) =>
    apiFetch<DomainConfig>(`/settings/tenant/${tenantId}/domain`),

  initiateCustomDomainVerification: (tenantId: string, customDomain: string) =>
    apiFetch<{ verificationToken: string; dnsRecord: string }>(
      `/settings/tenant/${tenantId}/domain/verify`,
      { method: 'POST', body: JSON.stringify({ customDomain }) },
    ),

  confirmCustomDomain: (tenantId: string) =>
    apiFetch<{ verified: boolean }>(`/settings/tenant/${tenantId}/domain/confirm`, {
      method: 'POST',
    }),

  getBrandingConfig: (tenantId: string) =>
    apiFetch<BrandingConfig>(`/settings/tenant/${tenantId}/branding`),

  updateBranding: (tenantId: string, branding: Partial<BrandingConfig>) =>
    apiFetch<BrandingConfig>(`/settings/tenant/${tenantId}/branding`, {
      method: 'PUT',
      body: JSON.stringify(branding),
    }),

  // ---------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------
  getSecurityConfig: (tenantId: string) =>
    apiFetch<TenantSecurityConfig>(`/settings/tenant/${tenantId}/security`),

  updateSecurityConfig: (tenantId: string, security: Partial<TenantSecurityConfig>) =>
    apiFetch<TenantSecurityConfig>(`/settings/tenant/${tenantId}/security`, {
      method: 'PUT',
      body: JSON.stringify(security),
    }),

  addToIpWhitelist: (tenantId: string, ip: string) =>
    apiFetch<string[]>(`/settings/tenant/${tenantId}/security/ip-whitelist`, {
      method: 'POST',
      body: JSON.stringify({ ip }),
    }),

  removeFromIpWhitelist: (tenantId: string, ip: string) =>
    apiFetch<string[]>(`/settings/tenant/${tenantId}/security/ip-whitelist/${encodeURIComponent(ip)}`, {
      method: 'DELETE',
    }),

  addToIpBlacklist: (tenantId: string, ip: string) =>
    apiFetch<string[]>(`/settings/tenant/${tenantId}/security/ip-blacklist`, {
      method: 'POST',
      body: JSON.stringify({ ip }),
    }),

  removeFromIpBlacklist: (tenantId: string, ip: string) =>
    apiFetch<string[]>(`/settings/tenant/${tenantId}/security/ip-blacklist/${encodeURIComponent(ip)}`, {
      method: 'DELETE',
    }),

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  getNotificationConfig: (tenantId: string) =>
    apiFetch<TenantNotificationConfig>(`/settings/tenant/${tenantId}/notifications`),

  updateNotificationConfig: (tenantId: string, notification: Partial<TenantNotificationConfig>) =>
    apiFetch<TenantNotificationConfig>(`/settings/tenant/${tenantId}/notifications`, {
      method: 'PUT',
      body: JSON.stringify(notification),
    }),

  // ---------------------------------------------------------------------------
  // Feature Flags
  // ---------------------------------------------------------------------------
  getFeatureFlags: (tenantId: string) =>
    apiFetch<FeatureFlagsConfig>(`/settings/tenant/${tenantId}/features`),

  updateFeatureFlags: (tenantId: string, flags: Partial<FeatureFlagsConfig>) =>
    apiFetch<FeatureFlagsConfig>(`/settings/tenant/${tenantId}/features`, {
      method: 'PUT',
      body: JSON.stringify(flags),
    }),

  enableModule: (tenantId: string, moduleCode: string) =>
    apiFetch<string[]>(`/settings/tenant/${tenantId}/features/modules/${moduleCode}/enable`, {
      method: 'POST',
    }),

  disableModule: (tenantId: string, moduleCode: string) =>
    apiFetch<string[]>(`/settings/tenant/${tenantId}/features/modules/${moduleCode}/disable`, {
      method: 'POST',
    }),

  // ---------------------------------------------------------------------------
  // Data Retention
  // ---------------------------------------------------------------------------
  getDataRetentionConfig: (tenantId: string) =>
    apiFetch<DataRetentionConfig>(`/settings/tenant/${tenantId}/data-retention`),

  updateDataRetentionConfig: (tenantId: string, retention: Partial<DataRetentionConfig>) =>
    apiFetch<DataRetentionConfig>(`/settings/tenant/${tenantId}/data-retention`, {
      method: 'PUT',
      body: JSON.stringify(retention),
    }),
};
