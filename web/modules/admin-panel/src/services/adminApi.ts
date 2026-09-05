/**
 * Admin API Service - Barrel Export
 *
 * Backward-compatible re-export of all decomposed modules.
 * All existing imports like `import { systemApi } from '../services/adminApi'` continue to work.
 *
 * Decomposition (H9 fix):
 *   http-client.ts        -- apiFetch, buildQueryString, retry logic
 *   types/                -- ~90 interfaces/types/enums organized by domain
 *   api/system.ts         -- systemApi
 *   api/analytics.ts      -- analyticsApi
 *   api/reports.ts        -- reportsApi
 *   api/database.ts       -- databaseApi
 *   api/support.ts        -- supportApi
 *   api/security.ts       -- securityApi
 *   api/settings.ts       -- settingsApi, systemSettingsApi
 *   api/tenant-config.ts  -- tenantConfigApi   (extracted from settings)
 *   api/email-templates.ts-- emailTemplatesApi  (extracted from settings)
 *   api/impersonation.ts  -- impersonationApi
 *   api/debug.ts          -- debugApi
 *   api/tenants.ts        -- tenantsApi
 *   api/users.ts          -- usersApi
 *   api/modules.ts        -- modulesApi
 *   api/audit.ts          -- auditApi
 *   api/billing.ts        -- billingApi
 */

// HTTP Client
export { apiFetch, buildQueryString } from './http-client';

// All types
export * from './types';

// Domain APIs
export { systemApi } from './api/system';
export { analyticsApi } from './api/analytics';
export { reportsApi } from './api/reports';
export { databaseApi } from './api/database';
export { supportApi } from './api/support';
export { securityApi } from './api/security';
export { settingsApi, systemSettingsApi } from './api/settings';
export { tenantConfigApi } from './api/tenant-config';
export { emailTemplatesApi } from './api/email-templates';
export { impersonationApi } from './api/impersonation';
export { debugApi } from './api/debug';
export { tenantsApi } from './api/tenants';
export { usersApi } from './api/users';
export { modulesApi } from './api/modules';
export { auditApi } from './api/audit';
export { billingApi } from './api/billing';
export { messagingApi } from './api/messaging';
export type {
  ComplianceStats,
  LegalHold,
  CreateLegalHoldInput,
  RetentionPolicy,
  RetentionPolicyUpdate,
  MessagingAuditEntry,
  MessagingAuditFilters,
  ExportRecord,
  RetentionBucket,
  DailyAuditData,
  ExportTriggerResult,
  AiPersonaDefinition,
} from './api/messaging';
export type {
  MessagingMonitoringStats,
  MessagingMonitoringTotals,
  MessagingTenantsOverview,
  MessagingOutboxHealth,
  TenantMessagingOverviewRow,
} from './types/messaging';
