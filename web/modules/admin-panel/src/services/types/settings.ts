/**
 * Settings domain types (System Settings, Feature Toggles, Maintenance, Performance, Errors, Jobs)
 */

import type { AdminApiRouteResponse } from './generated/admin-route-contracts';

// ============================================================================
// System Settings Types
// ============================================================================

export interface SystemSetting {
  key: string;
  value: string | number | boolean | Record<string, unknown>;
  category: string;
  description: string;
  isEncrypted?: boolean;
  isReadOnly?: boolean;
  validationRules?: Record<string, unknown>;
  updatedAt: string;
  updatedBy?: string;
}

export interface TenantConfiguration {
  tenantId: string;
  configuration: Record<string, unknown>;
  branding?: {
    logo?: string;
    primaryColor?: string;
    secondaryColor?: string;
    favicon?: string;
    customCss?: string;
  };
  integrations?: Array<{
    type: string;
    isEnabled: boolean;
    config: Record<string, unknown>;
  }>;
  apiKeys?: Array<{
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    lastUsedAt?: string;
    expiresAt?: string;
  }>;
  webhooks?: Array<{
    id: string;
    url: string;
    events: string[];
    isActive: boolean;
    secretHash?: string;
  }>;
  updatedAt: string;
}

export type EmailTemplate = AdminApiRouteResponse<'GET /settings/email-templates'>[number];
export type EmailTemplateVariable = EmailTemplate['variables'][number];

export interface IpAccessRule {
  id: string;
  tenantId?: string;
  ruleType: 'whitelist' | 'blacklist';
  ipAddress: string;
  description?: string;
  isActive: boolean;
  expiresAt?: string;
  hitCount: number;
  lastHitAt?: string;
  createdBy?: string;
  createdAt: string;
}

// ============================================================================
// Feature Toggle Types
// ============================================================================

export type FeatureToggleStatus = 'enabled' | 'disabled' | 'percentage_rollout' | 'scheduled';
export type MaintenanceStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'extended';
export type JobStatus =
  | 'pending'
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retrying';

export type FeatureToggle =
  AdminApiRouteResponse<'GET /system/settings/feature-toggles'>['items'][number];

export type CreateFeatureToggleInput = Pick<FeatureToggle, 'key' | 'name'> &
  Partial<
    Pick<
      FeatureToggle,
      | 'description'
      | 'scope'
      | 'status'
      | 'category'
      | 'conditions'
      | 'rolloutPercentage'
      | 'defaultValue'
      | 'variants'
      | 'requiresRestart'
      | 'isExperimental'
    >
  >;

export type UpdateFeatureToggleInput = Partial<
  Pick<
    FeatureToggle,
    | 'name'
    | 'description'
    | 'status'
    | 'category'
    | 'conditions'
    | 'rolloutPercentage'
    | 'enabledTenants'
    | 'disabledTenants'
    | 'defaultValue'
    | 'variants'
    | 'deprecatedAt'
    | 'deprecationMessage'
  >
>;

export interface MaintenanceWindow {
  id: string;
  title: string;
  description: string;
  scope: 'global' | 'tenant' | 'service';
  type: 'scheduled' | 'emergency' | 'rolling';
  status: MaintenanceStatus;
  tenantId?: string;
  affectedServices?: Array<{ name: string; status: string }>;
  scheduledStart: string;
  scheduledEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  userMessage?: string;
  allowReadOnlyAccess: boolean;
  bypassForSuperAdmins: boolean;
  createdBy: string;
  createdAt: string;
}

export interface PerformanceMetrics {
  service: string;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  throughput: number;
  errorRate: number;
  apdexScore: number;
  timestamp: string;
}

export type PerformanceDashboard = AdminApiRouteResponse<'GET /system/performance/dashboard'>;

export type ErrorGroup = AdminApiRouteResponse<'GET /system/errors/groups'>['items'][number];

export interface ErrorOccurrence {
  id: string;
  groupId: string;
  message: string;
  stackTrace?: string;
  context?: Record<string, unknown>;
  tenantId?: string;
  userId?: string;
  timestamp: string;
}

export type BackgroundJob = AdminApiRouteResponse<'GET /system/jobs'>['items'][number];

export type JobQueue = AdminApiRouteResponse<'GET /system/jobs/queues'>[number];
