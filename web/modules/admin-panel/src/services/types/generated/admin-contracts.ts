/**
 * GENERATED — DO NOT EDIT.
 *
 * Produced by `npm run codegen:admin-contracts` from the backend types named
 * in `tools/codegen/admin-contracts/manifest.ts`.
 *
 * These are WIRE shapes: what arrives at `JSON.parse`, not what the backend
 * holds in memory. `Date` is `string`, optional keys are absent rather than
 * `undefined`, and enums are unions of their serialized values.
 *
 * Editing this file by hand re-creates the problem it exists to remove: a
 * frontend copy of a contract that can drift from its owner. Change the
 * backend type and regenerate. CI runs `codegen:admin-contracts:check`.
 */

// ==========================================================================
// analytics
// ==========================================================================

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TenantMetrics {
  total: number;
  active: number;
  inactive: number;
  trial: number;
  suspended: number;
  newThisMonth: number;
  churnedThisMonth: null | number;
  churnRate: null | number;
  growthRate: null | number;
  byPlan: Record<string, number>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface UserMetrics {
  total: number;
  active: number;
  inactive: number;
  newThisMonth: number;
  activeLastDay: number;
  activeLastWeek: number;
  activeLastMonth: number;
  growthRate: number;
  avgUsersPerTenant: number;
  byRole: Record<string, number>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface FinancialMetrics {
  mrr: number;
  arr: number;
  arpu: number;
  arppu: number;
  ltv: number;
  totalRevenue: number;
  revenueThisMonth: number;
  revenueGrowthRate: null | number;
  pendingPayments: number;
  overduePayments: number;
  refunds: number;
  byPlan: Record<string, number>;
  byCurrency: Record<string, number>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface AnalyticsSystemMetrics {
  totalStorageBytes: null | number;
  usedStorageBytes: null | number;
  storageUtilization: null | number;
  apiCallsToday: null | number;
  apiCallsThisMonth: null | number;
  avgResponseTimeMs: null | number;
  errorRate: null | number;
  uptimePercent: null | number;
  activeConnections: null | number;
  queuedJobs: null | number;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface UsageMetrics {
  moduleUsage: {
    dashboard?: ModuleUsageStats;
    farm_management?: ModuleUsageStats;
    sensor_monitoring?: ModuleUsageStats;
    alerts?: ModuleUsageStats;
    reports?: ModuleUsageStats;
    hr_module?: ModuleUsageStats;
    billing?: ModuleUsageStats;
  };
  featureAdoption: Record<string, number>;
  topFeatures: Array<{
    feature: string;
    usage: number;
  }>;
  peakHours: number[];
  avgDailyActiveUsers: number;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
    borderColor?: string;
  }>;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TimeSeriesPoint {
  date: string;
  value: null | number;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TimeSeriesData {
  label: string;
  data: TimeSeriesPoint[];
  color?: string;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface TimeSeriesResponse {
  range: "7d" | "30d" | "90d" | "1y";
  granularity: "day" | "week" | "month";
  data: TimeSeriesPoint[];
  source: string;
  asOf: string;
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export interface DashboardSummary {
  tenants: TenantMetrics;
  users: UserMetrics;
  financial: FinancialMetrics;
  system: AnalyticsSystemMetrics;
  usage: UsageMetrics;
  generatedAt: string;
  unavailable?: string[];
}

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export type ReportType = "tenant_overview" | "tenant_churn" | "financial_revenue" | "financial_payments" | "usage_modules" | "usage_features" | "system_performance";

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export type ReportFormat = "json" | "csv" | "pdf";

/** @see apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts */
export type ReportExecutionStatus = "pending" | "running" | "completed" | "failed" | "unavailable";

/** @see apps/admin-api-service/src/analytics/services/analytics.service.ts */
export interface ComparisonDto {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  trend: "up" | "down" | "stable";
}

// ==========================================================================
// shared
// ==========================================================================

/** @see transitive */
export interface ModuleUsageStats {
  activeUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
}

/** @see transitive */
export interface ImpersonationPermissions {
  canViewData: boolean;
  canModifyData: boolean;
  canAccessSettings: boolean;
  canManageUsers: boolean;
  canViewBilling: boolean;
  canExportData: boolean;
  restrictedModules?: string[];
  allowedModules?: string[];
}

/** @see transitive */
export interface ImpersonationAction {
  action: string;
  resource: string;
  resourceId?: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

/** @see transitive */
export interface SafeImpersonationSession {
  id: string;
  superAdminId: string;
  superAdminEmail?: string;
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  status: "active" | "ended" | "expired" | "terminated";
  reason: "support_request" | "debugging" | "configuration" | "onboarding_assistance" | "security_investigation" | "data_verification" | "other";
  reasonDetails?: string;
  ticketReference?: string;
  permissions?: ImpersonationPermissions;
  ipAddress?: string;
  userAgent?: string;
  mfaCompleted: boolean;
  expiresAt: string;
  endedAt?: string;
  endReason?: string;
  actionsPerformed?: ImpersonationAction[];
  actionCount: number;
  accessedResources?: Array<{
    type: string;
    id: string;
    action: string;
    timestamp: string;
  }>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ==========================================================================
// impersonation
// ==========================================================================

/** @see apps/admin-api-service/src/impersonation/services/impersonation.service.ts */
export interface ImpersonationAuditSummary {
  windowStart: string;
  windowEnd: string;
  totalSessionsInWindow: number;
  actionsLoggedInWindow: number;
  sessionsByReasonInWindow: {
    support_request: number;
    debugging: number;
    configuration: number;
    onboarding_assistance: number;
    security_investigation: number;
    data_verification: number;
    other: number;
  };
  topImpersonatorsInWindow: Array<{
    adminId: string;
    email: string;
    sessionCount: number;
  }>;
  topTargetTenantsInWindow: Array<{
    tenantId: string;
    tenantName: string;
    sessionCount: number;
  }>;
  recentSessionsInWindow: SafeImpersonationSession[];
  activeSessionsNow: number;
  activePermissionsNow: number;
}

// ==========================================================================
// security
// ==========================================================================

/** @see apps/admin-api-service/src/security/services/compliance.service.ts */
export interface ComplianceRequirement {
  id: string;
  framework: "gdpr" | "ccpa" | "hipaa" | "pci_dss" | "sox" | "iso27001";
  requirement: string;
  description: string;
  category: string;
  isMandatory: boolean;
  verificationMethod: string;
}

/** @see apps/admin-api-service/src/security/services/compliance.service.ts */
export interface ComplianceCheckResult {
  checkedAt: string;
  requirement: ComplianceRequirement;
  status: "compliant" | "non_compliant" | "partial" | "not_applicable";
  details: string;
  evidence?: string;
  remediation?: string;
}
