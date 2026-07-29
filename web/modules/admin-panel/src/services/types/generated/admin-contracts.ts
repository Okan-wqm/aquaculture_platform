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

/** @see transitive */
export interface ImpersonationPermission {
  id: string;
  superAdminId: string;
  superAdminEmail?: string;
  canImpersonate: boolean;
  isActive: boolean;
  allowedTenants?: string[];
  restrictedTenants?: string[];
  defaultPermissions?: ImpersonationPermissions;
  maxSessionDurationMinutes: number;
  maxConcurrentSessions: number;
  requireReason: boolean;
  requireTicketReference: boolean;
  notifyTenantAdmin: boolean;
  grantedBy?: string;
  grantedAt?: string;
  expiresAt?: string;
  notes?: string;
  revokedBy?: null | string;
  revokedAt?: null | string;
  createdAt: string;
  updatedAt: string;
}

/** @see transitive */
export interface ImpersonationContext {
  sessionId: string;
  superAdminId: string;
  targetTenantId: string;
  targetUserId?: string;
  permissions: ImpersonationPermissions;
  expiresAt: string;
  isActive: boolean;
}

/** @see transitive */
export interface TenantLimitsDto {
  maxUsers?: number;
  maxFarms?: number;
  maxPonds?: number;
  maxSensors?: number;
  maxAlertRules?: number;
  dataRetentionDays?: number;
  apiRateLimit?: number;
  storageGb?: number;
}

/** @see transitive */
export interface UserStatsByRole {
  total: number;
  active: number;
  inactive: number;
  byRole: {
    admin: number;
    manager: number;
    supervisor: number;
    operator: number;
    viewer: number;
  };
  recentlyActive: number;
  newUsersLast30Days: number;
}

/** @see transitive */
export interface ResourceUsage {
  storage: {
    usedGb: number;
    limitGb: number;
    percentage: number;
  };
  users: {
    count: number;
    limit: number;
    percentage: number;
  };
  farms: {
    count: number;
    limit: number;
    percentage: number;
  };
  sensors: {
    count: number;
    limit: number;
    percentage: number;
  };
  apiCalls: {
    last24h: number;
    last7d: number;
    limit: number;
  };
}

/** @see transitive */
export interface TenantModuleUsageStats {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  isActive: boolean;
  assignedAt: string;
  usageCount?: number;
  lastUsedAt?: string;
}

/** @see transitive */
export interface BillingSummary {
  currentPlan: "free" | "trial" | "starter" | "professional" | "enterprise";
  monthlyAmount: number;
  currency: string;
  billingCycle: string;
  paymentStatus: string;
  nextBillingDate: null | string;
  lastPaymentDate: null | string;
  lastPaymentAmount: null | number;
}

/** @see transitive */
export interface JobProgress {
  current: number;
  total: number;
  percentage: number;
  message?: string;
  checkpoint?: unknown;
}

/** @see transitive */
export interface JobRetryPolicy {
  maxRetries: number;
  retryDelay: number;
  exponentialBackoff: boolean;
  backoffMultiplier?: number;
  maxDelay?: number;
}

/** @see transitive */
export interface StackFrame {
  filename: string;
  function: string;
  lineno: number;
  colno?: number;
  context?: string[];
  inApp?: false | true;
}

/** @see transitive */
export interface ErrorContext {
  user?: {
    id: string;
    email?: string;
    tenantId?: string;
  };
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    queryParams?: Record<string, string>;
  };
  response?: {
    statusCode: number;
    body?: unknown;
  };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: Array<{
    type: string;
    category: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }>;
}

/** @see transitive */
export interface FeatureCondition {
  type: "tenant_id" | "user_role" | "plan_type" | "region" | "custom";
  operator: "equals" | "not_equals" | "contains" | "in" | "not_in" | "regex";
  value: string | string[];
}

/** @see transitive */
export interface RolloutSchedule {
  startDate: string;
  endDate?: string;
  percentage: number;
  targetPercentage?: number;
  incrementPerDay?: number;
}

/** @see transitive */
export interface PlanPricing {
  monthly: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
  };
  quarterly: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
    discountPercent: number;
  };
  semiAnnual: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
    discountPercent: number;
  };
  annual: {
    basePrice: number;
    perUserPrice: number;
    perFarmPrice: number;
    perModulePrice: number;
    discountPercent: number;
  };
  currency: string;
}

/** @see transitive */
export interface CustomPlanLineItem {
  metric: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** @see transitive */
export interface PricingLineItem {
  metric: "base_price" | "per_user" | "per_farm" | "per_pond" | "per_sensor" | "per_device" | "per_gb_storage" | "per_gb_transfer" | "per_api_call" | "per_alert" | "per_report" | "per_sms" | "per_email" | "per_integration" | "per_workflow";
  metricLabel: string;
  quantity: number;
  includedQuantity: number;
  billableQuantity: number;
  unitPrice: number;
  total: number;
  tierMultiplier: number;
}

/** @see transitive */
export interface RefundEntry {
  amount: number;
  reason: string;
  refundedAt: string;
  refundId?: string;
}

/** @see transitive */
export interface GeoLocation {
  country: string;
  countryCode: string;
  region: string;
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/** @see transitive */
export interface ThreatIntelligence {
  id: string;
  indicatorType: "ip" | "domain" | "url" | "hash" | "email" | "user_agent" | "cidr";
  value: string;
  threatLevel: "low" | "medium" | "high" | "critical";
  source: string;
  description?: null | string;
  threatTypes?: null | string[];
  tags?: null | string[];
  confidence: number;
  isActive: boolean;
  validFrom?: null | string;
  validUntil?: null | string;
  hitCount: number;
  lastSeenAt?: null | string;
  firstSeenAt?: null | string;
  relatedIndicators?: null | string[];
  geoData?: null | GeoLocation;
  metadata?: null | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** @see transitive */
export interface SecurityHealthFactor {
  name: string;
  score: number;
  weight: number;
  description: string;
}

/** @see transitive */
export interface DeviceInfo {
  userAgent: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  device: string;
  deviceType: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
  isMobile: boolean;
  isBot: boolean;
}

/** @see transitive */
export interface AnomalyDetails {
  type: string;
  score: number;
  threshold: number;
  baseline: Record<string, unknown>;
  current: Record<string, unknown>;
  factors: string[];
}

/** @see transitive */
export interface ThreatIndicator {
  type: "ip" | "domain" | "url" | "hash" | "email" | "user_agent";
  value: string;
  source: string;
  confidence: number;
  lastSeen: string;
  tags: string[];
}

/** @see transitive */
export interface RequestInfo {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  responseStatus?: number;
  responseTime?: number;
  responseSize?: number;
}

/** @see transitive */
export interface DatabaseMetrics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingClients: number;
  databaseSize: string;
  tablesCount: number;
}

/** @see transitive */
export interface PlatformMetrics {
  totalTenants: number;
  activeTenants: number;
  totalUsers: number;
  totalFarms: number;
  totalSensors: number;
  activeSensors: number;
  totalAlertRules: number;
  activeAlertRules: number;
  eventsLast24h: number;
  apiCallsLast24h: number;
}

/** @see transitive */
export interface ResourceMetrics {
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  cpuUsage: {
    user: number;
    system: number;
  };
  uptime: number;
  nodeVersion: string;
  platform: string;
}

/** @see transitive */
export interface CircuitBreakerInfo {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  lastFailureTime: number;
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

/** @see apps/admin-api-service/src/impersonation/services/impersonation.service.ts */
export interface StartedImpersonationSession {
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
  impersonationToken: string;
}

/** @see apps/admin-api-service/src/impersonation/services/impersonation.service.ts */
export interface ImpersonationEligibility {
  allowed: boolean;
  reason?: string;
  permission?: ImpersonationPermission;
}

/** @see apps/admin-api-service/src/impersonation/services/impersonation.service.ts */
export interface ImpersonationValidation {
  valid: boolean;
  context: null | ImpersonationContext;
}

/** @see apps/admin-api-service/src/impersonation/services/impersonation.service.ts */
export interface ActiveSessionCount {
  count: number;
}

/** @see apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts */
export interface StartImpersonationRequest {
  targetTenantId: string;
  targetTenantName?: string;
  targetUserId?: string;
  targetUserEmail?: string;
  reason: "support_request" | "debugging" | "configuration" | "onboarding_assistance" | "security_investigation" | "data_verification" | "other";
  reasonDetails?: string;
  ticketReference?: string;
  permissions?: {
    canViewData?: false | true;
    canModifyData?: false | true;
    canAccessSettings?: false | true;
    canManageUsers?: false | true;
    canViewBilling?: false | true;
    canExportData?: false | true;
    restrictedModules?: string[];
    allowedModules?: string[];
  };
  durationMinutes?: number;
}

/** @see apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts */
export interface GrantPermissionDto {
  superAdminId: string;
  superAdminEmail?: string;
  allowedTenants?: string[];
  restrictedTenants?: string[];
  defaultPermissions?: ImpersonationPermissions;
  maxSessionDurationMinutes?: number;
  maxConcurrentSessions?: number;
  requireReason?: false | true;
  requireTicketReference?: false | true;
  notifyTenantAdmin?: false | true;
  expiresAt?: string;
  notes?: string;
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

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type ComplianceType = "gdpr" | "ccpa" | "hipaa" | "pci_dss" | "sox" | "iso27001";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type DataRequestStatus = "pending" | "completed" | "in_progress" | "expired" | "rejected";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type DataRequestType = "access" | "deletion" | "portability" | "rectification" | "restriction";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type SecurityEventStatus = "detected" | "investigating" | "confirmed" | "mitigated" | "false_positive" | "escalated";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type SecurityEventType = "failed_login" | "brute_force_attempt" | "suspicious_activity" | "unauthorized_access" | "privilege_escalation" | "data_exfiltration" | "malware_detected" | "api_abuse" | "rate_limit_exceeded" | "sql_injection_attempt" | "xss_attempt" | "csrf_attempt" | "account_lockout" | "password_spray" | "credential_stuffing" | "session_hijacking" | "ip_blacklisted" | "geo_anomaly" | "device_anomaly" | "time_anomaly";

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export interface SecurityDashboardStats {
  totalSecurityEvents: number;
  criticalEvents: number;
  activeIncidents: number;
  resolvedIncidents: number;
  threatsBlocked: number;
  eventsLast24h: number;
  eventsLast7d: number;
  eventsLast30d: number;
  eventsTrend: "stable" | "increasing" | "decreasing";
  eventsByType: {
    failed_login: number;
    brute_force_attempt: number;
    suspicious_activity: number;
    unauthorized_access: number;
    privilege_escalation: number;
    data_exfiltration: number;
    malware_detected: number;
    api_abuse: number;
    rate_limit_exceeded: number;
    sql_injection_attempt: number;
    xss_attempt: number;
    csrf_attempt: number;
    account_lockout: number;
    password_spray: number;
    credential_stuffing: number;
    session_hijacking: number;
    ip_blacklisted: number;
    geo_anomaly: number;
    device_anomaly: number;
    time_anomaly: number;
  };
  eventsBySeverity: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  topSourceIPs: Array<{
    ip: string;
    count: number;
    threatLevel: "low" | "medium" | "high" | "critical";
  }>;
  topTargetedUsers: Array<{
    userId: string;
    userName: string;
    count: number;
  }>;
  topEventTypes: Array<{
    type: "failed_login" | "brute_force_attempt" | "suspicious_activity" | "unauthorized_access" | "privilege_escalation" | "data_exfiltration" | "malware_detected" | "api_abuse" | "rate_limit_exceeded" | "sql_injection_attempt" | "xss_attempt" | "csrf_attempt" | "account_lockout" | "password_spray" | "credential_stuffing" | "session_hijacking" | "ip_blacklisted" | "geo_anomaly" | "device_anomaly" | "time_anomaly";
    count: number;
  }>;
  eventsTimeline: Array<{
    date: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
  }>;
}

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export interface SecurityEventStats {
  total: number;
  byThreatLevel: {
    low?: number;
    medium?: number;
    high?: number;
    critical?: number;
  };
  byEventType: {
    failed_login?: number;
    brute_force_attempt?: number;
    suspicious_activity?: number;
    unauthorized_access?: number;
    privilege_escalation?: number;
    data_exfiltration?: number;
    malware_detected?: number;
    api_abuse?: number;
    rate_limit_exceeded?: number;
    sql_injection_attempt?: number;
    xss_attempt?: number;
    csrf_attempt?: number;
    account_lockout?: number;
    password_spray?: number;
    credential_stuffing?: number;
    session_hijacking?: number;
    ip_blacklisted?: number;
    geo_anomaly?: number;
    device_anomaly?: number;
    time_anomaly?: number;
  };
  byStatus: {
    detected?: number;
    investigating?: number;
    confirmed?: number;
    mitigated?: number;
    false_positive?: number;
    escalated?: number;
  };
}

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export interface IncidentStats {
  total: number;
  byStatus: {
    investigating?: number;
    open?: number;
    contained?: number;
    eradicated?: number;
    recovered?: number;
    closed?: number;
  };
  bySeverity: {
    low?: number;
    medium?: number;
    high?: number;
    critical?: number;
  };
}

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export interface ThreatIntelStats {
  total: number;
  byIndicatorType: {
    ip?: number;
    domain?: number;
    url?: number;
    hash?: number;
    email?: number;
    user_agent?: number;
    cidr?: number;
  };
  byThreatLevel: {
    low?: number;
    medium?: number;
    high?: number;
    critical?: number;
  };
}

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export interface ThreatCheckResult {
  isThreat: boolean;
  threat: null | ThreatIntelligence;
}

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export interface SecurityHealthScore {
  score: number;
  dataStatus: "live" | "stale" | "no_data";
  lastSeenAt: null | string;
  factors: SecurityHealthFactor[];
  recommendations: string[];
}

/** @see apps/admin-api-service/src/security/services/security-monitoring.service.ts */
export type SecurityTelemetryStatus = "live" | "stale" | "no_data";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export interface SecurityEvent {
  id: string;
  eventType: "failed_login" | "brute_force_attempt" | "suspicious_activity" | "unauthorized_access" | "privilege_escalation" | "data_exfiltration" | "malware_detected" | "api_abuse" | "rate_limit_exceeded" | "sql_injection_attempt" | "xss_attempt" | "csrf_attempt" | "account_lockout" | "password_spray" | "credential_stuffing" | "session_hijacking" | "ip_blacklisted" | "geo_anomaly" | "device_anomaly" | "time_anomaly";
  threatLevel: "low" | "medium" | "high" | "critical";
  status: "detected" | "investigating" | "confirmed" | "mitigated" | "false_positive" | "escalated";
  title: string;
  description: string;
  ipAddress: string;
  geoLocation?: null | GeoLocation;
  deviceInfo?: null | DeviceInfo;
  tenantId?: null | string;
  userId?: null | string;
  userName?: null | string;
  targetResource?: null | string;
  targetEndpoint?: null | string;
  detectionSource: string;
  confidenceScore?: null | number;
  anomalyDetails?: null | AnomalyDetails;
  indicators?: null | ThreatIndicator[];
  rawData?: null | Record<string, unknown>;
  relatedActivityIds?: null | string[];
  autoMitigated: boolean;
  mitigationActions?: null | string[];
  investigationNotes?: null | string;
  assignedTo?: null | string;
  assignedToName?: null | string;
  assignedAt?: null | string;
  resolution?: null | string;
  resolvedAt?: null | string;
  resolvedBy?: null | string;
  tags?: null | string[];
  metadata?: null | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export interface SecurityIncident {
  id: string;
  incidentNumber: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "investigating" | "open" | "contained" | "eradicated" | "recovered" | "closed";
  category: string;
  attackVector?: null | string;
  affectedSystems?: null | string[];
  affectedTenants?: null | string[];
  dataBreached: boolean;
  affectedUsersCount: number;
  impactDescription?: null | string;
  businessImpact?: null | string;
  detectedAt?: null | string;
  containedAt?: null | string;
  eradicatedAt?: null | string;
  recoveredAt?: null | string;
  closedAt?: null | string;
  leadInvestigator?: null | string;
  leadInvestigatorName?: null | string;
  teamMembers?: null | string[];
  relatedSecurityEvents?: null | string[];
  rootCauseAnalysis?: null | string;
  lessonsLearned?: null | string;
  remediationSteps?: null | Array<{
    step: string;
    completed: boolean;
    completedAt?: string;
  }>;
  reportedToAuthorities: boolean;
  reportedAt?: null | string;
  reportReference?: null | string;
  timeline?: null | Array<{
    timestamp: string;
    action: string;
    actor: string;
    details?: string;
  }>;
  metadata?: null | Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export interface ActivityLog {
  id: string;
  tenantId?: null | string;
  tenantName?: null | string;
  userId?: null | string;
  userName?: null | string;
  userEmail?: null | string;
  category: "user_action" | "system_event" | "api_call" | "data_access" | "security_event" | "configuration" | "authentication";
  severity: "critical" | "debug" | "info" | "warning" | "error";
  action: string;
  description: string;
  entityType?: null | string;
  entityId?: null | string;
  entityName?: null | string;
  ipAddress: string;
  geoLocation?: null | GeoLocation;
  deviceInfo?: null | DeviceInfo;
  requestInfo?: null | RequestInfo;
  sessionId?: null | string;
  correlationId?: null | string;
  previousValue?: null | Record<string, unknown>;
  newValue?: null | Record<string, unknown>;
  changedFields?: null | string[];
  metadata?: null | Record<string, unknown>;
  tags?: null | string[];
  success: boolean;
  errorMessage?: null | string;
  errorCode?: null | string;
  duration?: null | number;
  createdAt: string;
  isArchived: boolean;
  archivedAt?: null | string;
}

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type ThreatLevel = "low" | "medium" | "high" | "critical";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type ThreatIndicatorType = "ip" | "domain" | "url" | "hash" | "email" | "user_agent" | "cidr";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type IncidentStatus = "investigating" | "open" | "contained" | "eradicated" | "recovered" | "closed";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type IncidentSeverity = "low" | "medium" | "high" | "critical";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type ActivityCategory = "user_action" | "system_event" | "api_call" | "data_access" | "security_event" | "configuration" | "authentication";

/** @see apps/admin-api-service/src/security/entities/security.entity.ts */
export type ActivitySeverity = "critical" | "debug" | "info" | "warning" | "error";

/** @see apps/admin-api-service/src/audit/audit.service.ts */
export interface AuditSummary {
  totalLogs: number;
  last24Hours: number;
  byAction: Array<{
    action: string;
    count: number;
  }>;
  bySeverity: Array<{
    severity: string;
    count: number;
  }>;
  byEntityType: Array<{
    entityType: string;
    count: number;
  }>;
  topUsers: Array<{
    userId: string;
    email: string;
    count: number;
  }>;
}

// ==========================================================================
// database
// ==========================================================================

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type BackupStatus = "pending" | "completed" | "failed" | "in_progress" | "expired";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type BackupType = "full" | "incremental" | "differential";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type MigrationStatus = "pending" | "running" | "completed" | "failed" | "rolled_back";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export type SchemaStatus = "creating" | "active" | "migrating" | "suspended" | "pending_deletion" | "deleted";

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export interface SchemaMigration {
  id: string;
  tenantId: null | string;
  schemaName: string;
  migrationName: string;
  version: string;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  upScript: string;
  downScript: string;
  errorMessage: string;
  executionTimeMs: number;
  isDryRun: boolean;
  affectedTables: string[];
  executedBy: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export interface TenantSchema {
  id: string;
  tenantId: string;
  schemaName: string;
  status: "creating" | "active" | "migrating" | "suspended" | "pending_deletion" | "deleted";
  currentVersion: string;
  sizeBytes: number;
  tableCount: number;
  connectionCount: number;
  maxConnections: number;
  metadata: Record<string, unknown>;
  lastMigrationAt: string;
  lastBackupAt: string;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/database-management/entities/database-management.entity.ts */
export interface DatabaseBackup {
  id: string;
  tenantId: null | string;
  schemaName: string;
  backupType: "full" | "incremental" | "differential";
  status: "pending" | "completed" | "failed" | "in_progress" | "expired";
  filePath: string;
  fileName: string;
  sizeBytes: number;
  checksum: string;
  isEncrypted: boolean;
  isCompressed: boolean;
  retentionDays: number;
  errorMessage: string;
  metadata: {
    tableCount?: number;
    rowCount?: number;
    version?: string;
    compressionRatio?: number;
    encryptionAlgorithm?: string;
    encryptionKeyId?: string;
  };
  startedAt: string;
  completedAt: string;
  expiresAt: string;
  createdAt: string;
}

// ==========================================================================
// debug
// ==========================================================================

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export const DebugSessionType = {
  QUERY_INSPECTION: "query_inspection",
  API_LOG_VIEWING: "api_log_viewing",
  CACHE_INSPECTION: "cache_inspection",
  FEATURE_FLAG_OVERRIDE: "feature_flag_override",
  PERFORMANCE_PROFILING: "performance_profiling",
  ERROR_DEBUGGING: "error_debugging",
} as const;
export type DebugSessionType = (typeof DebugSessionType)[keyof typeof DebugSessionType];
export const DEBUG_SESSION_TYPE_VALUES = Object.values(DebugSessionType);

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface DebugSession {
  id: string;
  adminId: string;
  tenantId: string;
  sessionType: "query_inspection" | "api_log_viewing" | "cache_inspection" | "feature_flag_override" | "performance_profiling" | "error_debugging";
  isActive: boolean;
  configuration?: Record<string, unknown>;
  filters?: {
    startTime?: string;
    endTime?: string;
    queryTypes?: Array<"select" | "insert" | "update" | "delete" | "transaction" | "schema">;
    apiEndpoints?: string[];
    cacheKeys?: string[];
    minDuration?: number;
    includeErrors?: false | true;
    userId?: string;
  };
  maxResults: number;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface CapturedQuery {
  id: string;
  debugSessionId?: string;
  tenantId: string;
  userId?: string;
  queryType: "select" | "insert" | "update" | "delete" | "transaction" | "schema";
  query: string;
  parameters?: unknown[];
  normalizedQuery?: string;
  durationMs: number;
  rowsAffected?: number;
  rowsReturned?: number;
  tableName?: string;
  explainPlan?: Record<string, unknown>;
  isSlowQuery: boolean;
  hasError: boolean;
  errorMessage?: string;
  stackTrace?: string;
  connectionSource?: string;
  timestamp: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface CapturedApiCall {
  id: string;
  debugSessionId?: string;
  tenantId: string;
  userId?: string;
  method: string;
  endpoint: string;
  fullUrl?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  queryParams?: Record<string, string>;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  durationMs: number;
  clientIp?: string;
  userAgent?: string;
  correlationId?: string;
  hasError: boolean;
  errorMessage?: string;
  timestamp: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts */
export interface FeatureFlagOverride {
  id: string;
  tenantId: string;
  featureKey: string;
  originalValue: unknown;
  overrideValue: unknown;
  isActive: boolean;
  adminId: string;
  reason?: string;
  expiresAt?: string;
  appliedAt?: string;
  revertedAt?: string;
  revertedBy?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ==========================================================================
// tenant
// ==========================================================================

/** @see apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts */
export interface TenantActivity {
  id: string;
  tenantId: string;
  activityType: "created" | "activated" | "suspended" | "deactivated" | "plan_changed" | "limits_updated" | "module_assigned" | "module_removed" | "user_added" | "user_removed" | "settings_updated" | "payment_received" | "payment_failed" | "trial_started" | "trial_expired" | "contact_updated" | "domain_changed";
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts */
export interface TenantNote {
  id: string;
  tenantId: string;
  content: string;
  category: string;
  isPinned: boolean;
  createdBy: string;
  createdByEmail?: string;
  createdAt: string;
  updatedAt: string;
}

/** @see libs/event-contracts/src/enums/tenant-plan.enum.ts */
export const TenantPlan = {
  FREE: "free",
  TRIAL: "trial",
  STARTER: "starter",
  PROFESSIONAL: "professional",
  ENTERPRISE: "enterprise",
} as const;
export type TenantPlan = (typeof TenantPlan)[keyof typeof TenantPlan];
export const TENANT_PLAN_VALUES = Object.values(TenantPlan);

/** @see libs/event-contracts/src/enums/tenant-status.enum.ts */
export const TenantStatus = {
  PENDING: "PENDING",
  PROVISIONING: "PROVISIONING",
  PROVISIONING_FAILED: "PROVISIONING_FAILED",
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  DEACTIVATED: "DEACTIVATED",
  CANCELLED: "CANCELLED",
  ARCHIVED: "ARCHIVED",
  PURGED: "PURGED",
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];
export const TENANT_STATUS_VALUES = Object.values(TenantStatus);

/** @see apps/admin-api-service/src/tenant/dto/tenant-summary.dto.ts */
export interface TenantSummaryDto {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  status: "PENDING" | "PROVISIONING" | "PROVISIONING_FAILED" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED" | "CANCELLED" | "ARCHIVED" | "PURGED";
  tier: "free" | "trial" | "starter" | "professional" | "enterprise";
  contactEmail?: string;
  description?: string;
  trialEndsAt: null | string;
  isTrialActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/tenant/dto/tenant-summary.dto.ts */
export interface TenantListItemDto {
  userCount: number;
  farmCount: number;
  sensorCount: number;
  id: string;
  name: string;
  slug: string;
  domain?: string;
  status: "PENDING" | "PROVISIONING" | "PROVISIONING_FAILED" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED" | "CANCELLED" | "ARCHIVED" | "PURGED";
  tier: "free" | "trial" | "starter" | "professional" | "enterprise";
  contactEmail?: string;
  description?: string;
  trialEndsAt: null | string;
  isTrialActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/tenant/dto/tenant-detail.dto.ts */
export interface TenantDetailDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  domain?: string;
  status: "PENDING" | "PROVISIONING" | "PROVISIONING_FAILED" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED" | "CANCELLED" | "ARCHIVED" | "PURGED";
  tier: "free" | "trial" | "starter" | "professional" | "enterprise";
  trialEndsAt?: string;
  suspendedAt?: null | string;
  suspendedReason?: null | string;
  availableActions: Array<"activate" | "suspend" | "deactivate" | "archive" | "retryProvisioning">;
  primaryContact?: {
    name: string;
    email: string;
    phone?: string;
    role: string;
  };
  billingContact?: {
    name: string;
    email: string;
    phone?: string;
    role: string;
  };
  billingEmail?: string;
  country?: string;
  region?: string;
  settings?: {
    timezone: string;
    locale: string;
    currency: string;
    dateFormat: string;
    measurementSystem: string;
    notificationPreferences: {
      email: boolean;
      sms: boolean;
      push: boolean;
      slack: boolean;
    };
    features: string[];
  };
  limits?: TenantLimitsDto;
  userCount: number;
  farmCount: number;
  sensorCount: number;
  maxStorage: number;
  isTrialActive: boolean;
  userStats?: UserStatsByRole;
  resourceUsage?: ResourceUsage;
  modules?: TenantModuleUsageStats[];
  recentActivities?: TenantActivity[];
  notes?: TenantNote[];
  billing?: BillingSummary;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/** @see apps/admin-api-service/src/tenant/dto/tenant-detail.dto.ts */
export type TenantAvailableAction = "activate" | "suspend" | "deactivate" | "archive" | "retryProvisioning";

// ==========================================================================
// support
// ==========================================================================

/** @see apps/admin-api-service/src/support/entities/support.entity.ts */
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  order: number;
  isRequired: boolean;
  estimatedMinutes: number;
  resourceUrl?: string;
  videoUrl?: string;
}

// ==========================================================================
// audit
// ==========================================================================

/** @see apps/admin-api-service/src/audit/audit.entity.ts */
export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId?: string;
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
  requestId?: string;
  sessionId?: string;
  createdAt: string;
  legalHold: boolean;
}

/** @see apps/admin-api-service/src/audit/audit.entity.ts */
export const AuditSeverity = {
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
} as const;
export type AuditSeverity = (typeof AuditSeverity)[keyof typeof AuditSeverity];
export const AUDIT_SEVERITY_VALUES = Object.values(AuditSeverity);

// ==========================================================================
// settings
// ==========================================================================

/** @see apps/admin-api-service/src/system-management/entities/job-queue.entity.ts */
export const JobStatus = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  RETRYING: "retrying",
  PAUSED: "paused",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];
export const JOB_STATUS_VALUES = Object.values(JobStatus);

/** @see apps/admin-api-service/src/system-management/entities/job-queue.entity.ts */
export interface BackgroundJob {
  id: string;
  name: string;
  queueName: string;
  jobType: "scheduled" | "immediate" | "recurring" | "delayed" | "triggered";
  status: "pending" | "scheduled" | "running" | "completed" | "failed" | "cancelled" | "retrying" | "paused";
  priority: number;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
  stackTrace?: string;
  progress?: JobProgress;
  tenantId?: string;
  userId?: string;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  attempts: number;
  maxAttempts: number;
  retryPolicy?: JobRetryPolicy;
  nextRetryAt?: string;
  cronExpression?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  timeoutMs: number;
  dependencies?: string[];
  parentJobId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  workerId?: string;
  isRecurring: boolean;
  isPaused: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts */
export interface ErrorGroup {
  id: string;
  fingerprint: string;
  severity: "debug" | "info" | "warning" | "error" | "critical" | "fatal";
  status: "new" | "acknowledged" | "in_progress" | "resolved" | "ignored" | "recurring";
  message: string;
  errorType?: string;
  service?: string;
  culprit?: string;
  occurrenceCount: number;
  userCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  affectedTenants?: string[];
  affectedReleases?: string[];
  tags?: Record<string, string[]>;
  assignedTo?: string;
  notes?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNotes?: string;
  linkedTicketUrl?: string;
  isRegression: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts */
export interface ErrorOccurrence {
  id: string;
  groupId: string;
  fingerprint: string;
  severity: "debug" | "info" | "warning" | "error" | "critical" | "fatal";
  message: string;
  errorType?: string;
  stackTrace?: string;
  stackFrames?: StackFrame[];
  context?: ErrorContext;
  service?: string;
  environment?: string;
  release?: string;
  tenantId?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts */
export const FeatureToggleScope = {
  GLOBAL: "global",
  TENANT: "tenant",
  USER: "user",
  ENVIRONMENT: "environment",
} as const;
export type FeatureToggleScope = (typeof FeatureToggleScope)[keyof typeof FeatureToggleScope];
export const FEATURE_TOGGLE_SCOPE_VALUES = Object.values(FeatureToggleScope);

/** @see apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts */
export const FeatureToggleStatus = {
  ENABLED: "enabled",
  DISABLED: "disabled",
  PERCENTAGE_ROLLOUT: "percentage_rollout",
  SCHEDULED: "scheduled",
} as const;
export type FeatureToggleStatus = (typeof FeatureToggleStatus)[keyof typeof FeatureToggleStatus];
export const FEATURE_TOGGLE_STATUS_VALUES = Object.values(FeatureToggleStatus);

/** @see apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts */
export interface FeatureToggle {
  id: string;
  key: string;
  name: string;
  description?: string;
  scope: "global" | "tenant" | "user" | "environment";
  status: "enabled" | "disabled" | "percentage_rollout" | "scheduled";
  category?: string;
  conditions?: FeatureCondition[];
  rolloutPercentage: number;
  rolloutSchedule?: RolloutSchedule;
  enabledTenants?: string[];
  disabledTenants?: string[];
  metadata?: Record<string, unknown>;
  defaultValue?: unknown;
  variants?: Array<{
    key: string;
    value: unknown;
    weight: number;
    description?: string;
  }>;
  requiresRestart: boolean;
  isExperimental: boolean;
  deprecatedAt?: string;
  deprecationMessage?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/settings/entities/system-setting.entity.ts */
export interface EmailTemplateVariable {
  name: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}

/** @see apps/admin-api-service/src/settings/entities/system-setting.entity.ts */
export interface EmailTemplate {
  id: string;
  code: string;
  name: string;
  description?: string;
  category: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  variables: EmailTemplateVariable[];
  isActive: boolean;
  isSystem: boolean;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/** @see apps/admin-api-service/src/settings/entities/system-setting.entity.ts */
export interface IpAccessRule {
  id: string;
  tenantId?: string;
  ipAddress: string;
  ruleType: "whitelist" | "blacklist";
  description?: string;
  isActive: boolean;
  expiresAt?: string;
  hitCount: number;
  lastHitAt?: string;
  createdAt: string;
  createdBy?: string;
}

/** @see apps/admin-api-service/src/system-management/entities/maintenance-mode.entity.ts */
export const MaintenanceStatus = {
  SCHEDULED: "scheduled",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  EXTENDED: "extended",
} as const;
export type MaintenanceStatus = (typeof MaintenanceStatus)[keyof typeof MaintenanceStatus];
export const MAINTENANCE_STATUS_VALUES = Object.values(MaintenanceStatus);

// ==========================================================================
// billing
// ==========================================================================

/** @see apps/admin-api-service/src/billing/entities/plan-definition.entity.ts */
export interface PlanFeatures {
  coreFeatures: string[];
  advancedFeatures: string[];
  premiumFeatures: string[];
  addOns: Array<{
    code: string;
    name: string;
    description: string;
    price: number;
    billingCycle: "monthly" | "quarterly" | "semi_annual" | "annual";
  }>;
}

/** @see apps/admin-api-service/src/billing/entities/plan-definition.entity.ts */
export interface PlanLimits {
  maxUsers: number;
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxModules: number;
  storageGB: number;
  dataRetentionDays: number;
  apiRateLimit: number;
  alertsEnabled: boolean;
  reportsEnabled: boolean;
  customBrandingEnabled: boolean;
  apiAccessEnabled: boolean;
  customIntegrationsEnabled: boolean;
  ssoEnabled: boolean;
  auditLogEnabled: boolean;
  prioritySupport: boolean;
  dedicatedAccountManager: boolean;
}

/** @see apps/admin-api-service/src/billing/entities/plan-definition.entity.ts */
export interface PlanDefinition {
  id: string;
  code: string;
  name: string;
  description?: string;
  shortDescription?: string;
  tier: "free" | "starter" | "professional" | "enterprise" | "custom";
  visibility: "public" | "private" | "deprecated";
  isActive: boolean;
  isRecommended: boolean;
  sortOrder: number;
  limits: PlanLimits;
  pricing: PlanPricing;
  features: PlanFeatures;
  trialDays?: number;
  gracePeriodDays?: number;
  upgradeMessage?: string;
  downgradeWarning?: string;
  stripeProductId?: string;
  stripePriceIds?: Record<string, string>;
  icon?: string;
  color?: string;
  badge?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/** @see apps/admin-api-service/src/billing/entities/module-pricing.entity.ts */
export interface PricingMetric {
  type: "base_price" | "per_user" | "per_farm" | "per_pond" | "per_sensor" | "per_device" | "per_gb_storage" | "per_gb_transfer" | "per_api_call" | "per_alert" | "per_report" | "per_sms" | "per_email" | "per_integration" | "per_workflow";
  price: number;
  currency: string;
  description?: string;
  minQuantity?: number;
  maxQuantity?: number;
  includedQuantity?: number;
}

/** @see apps/admin-api-service/src/billing/entities/module-pricing.entity.ts */
export interface TierMultipliers {
  free?: number;
  starter?: number;
  professional?: number;
  enterprise?: number;
  custom?: number;
}

/** @see apps/admin-api-service/src/billing/entities/module-pricing.entity.ts */
export interface ModulePricing {
  // not on the wire (does not survive JSON): getMetricPrice(), getTierMultiplier(), calculateMetricCost(), isCurrentlyValid()
  id: string;
  moduleId: string;
  moduleCode: string;
  pricingMetrics: PricingMetric[];
  tierMultipliers: TierMultipliers;
  currency: string;
  effectiveFrom: string;
  effectiveTo: null | string;
  isActive: boolean;
  notes: null | string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: null | string;
  updatedBy: null | string;
}

/** @see apps/admin-api-service/src/billing/entities/custom-plan.entity.ts */
export interface CustomPlanModule {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  quantities: {
    users?: number;
    farms?: number;
    ponds?: number;
    sensors?: number;
    devices?: number;
    storageGb?: number;
    apiCalls?: number;
    alerts?: number;
    reports?: number;
    integrations?: number;
  };
  lineItems: CustomPlanLineItem[];
  subtotal: number;
}

/** @see apps/admin-api-service/src/billing/entities/custom-plan.entity.ts */
export interface CustomPlan {
  // not on the wire (does not survive JSON): canModify(), canApprove(), canActivate(), isValid(), getTotalUsers(), getModule(), calculateDiscount()
  id: string;
  tenantId: string;
  name: string;
  description: null | string;
  basePlanId: null | string;
  basePlan: null | PlanDefinition;
  tier: "free" | "starter" | "professional" | "enterprise" | "custom";
  billingCycle: "monthly" | "quarterly" | "semi_annual" | "annual";
  modules: CustomPlanModule[];
  monthlySubtotal: number;
  discountPercent: number;
  discountAmount: number;
  discountReason: null | string;
  monthlyTotal: number;
  currency: string;
  status: "draft" | "pending_approval" | "approved" | "active" | "expired" | "rejected";
  validFrom: string;
  validTo: null | string;
  approvedBy: null | string;
  approvedAt: null | string;
  rejectionReason: null | string;
  notes: null | string;
  subscriptionId: null | string;
  createdAt: string;
  updatedAt: string;
  createdBy: null | string;
  updatedBy: null | string;
}

/** @see apps/admin-api-service/src/billing/entities/discount-code.entity.ts */
export const DiscountType = {
  PERCENTAGE: "percentage",
  FIXED_AMOUNT: "fixed_amount",
  FREE_TRIAL_EXTENSION: "free_trial_extension",
  FREE_MONTHS: "free_months",
} as const;
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];
export const DISCOUNT_TYPE_VALUES = Object.values(DiscountType);

/** @see apps/admin-api-service/src/billing/entities/discount-code.entity.ts */
export const DiscountAppliesTo = {
  ALL_PLANS: "all_plans",
  SPECIFIC_PLANS: "specific_plans",
  UPGRADES_ONLY: "upgrades_only",
  NEW_SUBSCRIPTIONS_ONLY: "new_subscriptions_only",
} as const;
export type DiscountAppliesTo = (typeof DiscountAppliesTo)[keyof typeof DiscountAppliesTo];
export const DISCOUNT_APPLIES_TO_VALUES = Object.values(DiscountAppliesTo);

/** @see apps/admin-api-service/src/billing/entities/discount-code.entity.ts */
export const DiscountDuration = {
  ONCE: "once",
  REPEATING: "repeating",
  FOREVER: "forever",
} as const;
export type DiscountDuration = (typeof DiscountDuration)[keyof typeof DiscountDuration];
export const DISCOUNT_DURATION_VALUES = Object.values(DiscountDuration);

/** @see apps/admin-api-service/src/billing/entities/discount-code.entity.ts */
export interface DiscountCode {
  id: string;
  code: string;
  name: string;
  description?: string;
  discountType: "percentage" | "fixed_amount" | "free_trial_extension" | "free_months";
  discountValue: number;
  appliesTo: "all_plans" | "specific_plans" | "upgrades_only" | "new_subscriptions_only";
  applicablePlanIds?: string[];
  duration: "once" | "repeating" | "forever";
  durationInMonths?: number;
  isActive: boolean;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  currentRedemptions: number;
  maxRedemptionsPerTenant?: number;
  minimumOrderAmount?: number;
  campaignId?: string;
  campaignName?: string;
  stripePromotionCodeId?: string;
  stripeCouponId?: string;
  metadata?: Record<string, unknown>;
  isReferralCode: boolean;
  referrerId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

/** @see apps/admin-api-service/src/billing/entities/pricing-metric.enum.ts */
export const PricingMetricType = {
  BASE_PRICE: "base_price",
  PER_USER: "per_user",
  PER_FARM: "per_farm",
  PER_POND: "per_pond",
  PER_SENSOR: "per_sensor",
  PER_DEVICE: "per_device",
  PER_GB_STORAGE: "per_gb_storage",
  PER_GB_TRANSFER: "per_gb_transfer",
  PER_API_CALL: "per_api_call",
  PER_ALERT: "per_alert",
  PER_REPORT: "per_report",
  PER_SMS: "per_sms",
  PER_EMAIL: "per_email",
  PER_INTEGRATION: "per_integration",
  PER_WORKFLOW: "per_workflow",
} as const;
export type PricingMetricType = (typeof PricingMetricType)[keyof typeof PricingMetricType];
export const PRICING_METRIC_TYPE_VALUES = Object.values(PricingMetricType);

/** @see libs/event-contracts/src/billing/billing-plan-tier.ts */
export const PlanTier = {
  FREE: "free",
  STARTER: "starter",
  PROFESSIONAL: "professional",
  ENTERPRISE: "enterprise",
  CUSTOM: "custom",
} as const;
export type PlanTier = (typeof PlanTier)[keyof typeof PlanTier];
export const PLAN_TIER_VALUES = Object.values(PlanTier);

/** @see apps/admin-api-service/src/billing/entities/usage-aggregation-readonly.entity.ts */
export const MeterType = {
  API_CALLS: "api_calls",
  DATA_STORAGE: "data_storage",
  SENSOR_READINGS: "sensor_readings",
  ALERTS_SENT: "alerts_sent",
  REPORTS_GENERATED: "reports_generated",
  USERS_ACTIVE: "users_active",
  FARMS_ACTIVE: "farms_active",
  PONDS_ACTIVE: "ponds_active",
  SENSORS_ACTIVE: "sensors_active",
  DATA_EXPORT: "data_export",
  INTEGRATIONS: "integrations",
  CUSTOM: "custom",
} as const;
export type MeterType = (typeof MeterType)[keyof typeof MeterType];
export const METER_TYPE_VALUES = Object.values(MeterType);

/** @see apps/admin-api-service/src/billing/services/subscription-types.ts */
export const SubscriptionStatus = {
  TRIAL: "trial",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELLED: "cancelled",
  SUSPENDED: "suspended",
  EXPIRED: "expired",
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];
export const SUBSCRIPTION_STATUS_VALUES = Object.values(SubscriptionStatus);

/** @see apps/admin-api-service/src/billing/services/subscription-types.ts */
export interface ModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

/** @see apps/admin-api-service/src/billing/services/subscription-types.ts */
export interface ModuleLineItem {
  metric: string;
  quantity: number;
  unitPrice: number;
  total: number;
  description?: string;
}

/** @see apps/admin-api-service/src/billing/services/subscription-types.ts */
export interface SubscriptionModuleConfig {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
  lineItems?: ModuleLineItem[];
  subtotal: number;
}

/** @see apps/admin-api-service/src/billing/services/subscription-types.ts */
export interface SubscriptionOverview {
  id: string;
  tenantId: string;
  tenantName: string;
  planTier: string;
  planName: string;
  status: "trial" | "active" | "past_due" | "cancelled" | "suspended" | "expired";
  billingCycle: "monthly" | "quarterly" | "semi_annual" | "annual";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  monthlyPrice: number;
  autoRenew: boolean;
  trialEndDate?: string;
  cancelledAt?: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/billing/services/subscription-types.ts */
export interface SubscriptionStats {
  totalSubscriptions: number;
  byStatus: {
    trial: number;
    active: number;
    past_due: number;
    cancelled: number;
    suspended: number;
    expired: number;
  };
  byPlanTier: Record<string, number>;
  byBillingCycle: Record<string, number>;
  mrr: number;
  arr: number;
  churnRate: number;
  averageRevenuePerUser: number;
  trialConversionRate: number;
  expiringThisMonth: number;
  pastDueCount: number;
  totalRevenue: number;
}

/** @see apps/admin-api-service/src/billing/services/pricing-calculator.service.ts */
export interface ModuleSelection {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
}

/** @see apps/admin-api-service/src/billing/services/pricing-calculator.service.ts */
export interface ModulePriceBreakdown {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  lineItems: PricingLineItem[];
  subtotal: number;
  tierDiscount: number;
  total: number;
}

/** @see apps/admin-api-service/src/billing/services/pricing-calculator.service.ts */
export interface PricingCalculation {
  modules: ModulePriceBreakdown[];
  subtotal: number;
  tierDiscount: number;
  discount: {
    code?: string;
    description?: string;
    amount: number;
    percent: number;
  };
  tax: number;
  taxRate: number;
  total: number;
  monthlyTotal: number;
  annualTotal: number;
  billingCycle: "monthly" | "quarterly" | "semi_annual" | "annual";
  billingCycleMultiplier: number;
  currency: string;
  tier: "free" | "starter" | "professional" | "enterprise" | "custom";
  calculatedAt: string;
}

/** @see apps/admin-api-service/src/billing/services/pricing-calculator.service.ts */
export interface QuoteRequest {
  modules: ModuleSelection[];
  tier: "free" | "starter" | "professional" | "enterprise" | "custom";
  billingCycle: "monthly" | "quarterly" | "semi_annual" | "annual";
  discountCode?: string;
  taxRate?: number;
}

/** @see apps/admin-api-service/src/billing/services/invoice-management.service.ts */
export interface InvoiceOverview {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  tenantName: string;
  tenantEmail?: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  status: "draft" | "pending" | "sent" | "paid" | "partially_paid" | "overdue" | "void" | "refunded";
  currency: string;
  dueDate: string;
  paidAt?: null | string;
  issueDate: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

/** @see apps/admin-api-service/src/billing/services/invoice-management.service.ts */
export interface InvoiceStats {
  totalInvoices: number;
  totalAmount: number;
  totalPaid: number;
  totalPending: number;
  totalOverdue: number;
  byStatus: Record<string, {
    count: number;
    amount: number;
  }>;
  byCurrency: Record<string, number>;
  avgPaymentTime: number;
  overdueRate: number;
  paidThisMonth: number;
  pendingThisMonth: number;
}

/** @see apps/admin-api-service/src/billing/services/payment-management.service.ts */
export interface PaymentOverview {
  id: string;
  tenantId: string;
  transactionId: string;
  invoiceId: string;
  invoiceNumber?: string;
  tenantName?: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string;
  paymentDate: string;
  processedAt?: string;
  failureReason?: string;
  refundedAmount: number;
  refunds: RefundEntry[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/** @see apps/admin-api-service/src/billing/services/usage-metering-management.service.ts */
export interface TenantUsageOverview {
  tenantId: string;
  tenantName?: string;
  meters: Array<{
    meterType: "api_calls" | "data_storage" | "sensor_readings" | "alerts_sent" | "reports_generated" | "users_active" | "farms_active" | "ponds_active" | "sensors_active" | "data_export" | "integrations" | "custom";
    totalUsage: number;
    unit: string;
    eventCount: number;
    peakUsage: number;
    averageUsage: number;
  }>;
  totalEvents: number;
  lastActivity?: string;
}

/** @see apps/admin-api-service/src/billing/services/usage-metering-management.service.ts */
export interface TopTenantUsage {
  tenantId: string;
  tenantName?: string;
  totalUsage: number;
  meterType: "api_calls" | "data_storage" | "sensor_readings" | "alerts_sent" | "reports_generated" | "users_active" | "farms_active" | "ponds_active" | "sensors_active" | "data_export" | "integrations" | "custom";
  unit: string;
  eventCount: number;
}

/** @see apps/admin-api-service/src/billing/services/usage-metering-management.service.ts */
export interface UsageSummaryStats {
  totalTenants: number;
  totalEvents: number;
  meterBreakdown: Array<{
    meterType: "api_calls" | "data_storage" | "sensor_readings" | "alerts_sent" | "reports_generated" | "users_active" | "farms_active" | "ponds_active" | "sensors_active" | "data_export" | "integrations" | "custom";
    totalUsage: number;
    avgPerTenant: number;
    maxPerTenant: number;
    unit: string;
    tenantCount: number;
  }>;
  periodCovered: {
    from: string;
    to: string;
  };
}

/** @see apps/admin-api-service/src/billing/services/usage-metering-management.service.ts */
export interface UsageTrendPoint {
  periodStart: string;
  periodEnd: string;
  meterType: "api_calls" | "data_storage" | "sensor_readings" | "alerts_sent" | "reports_generated" | "users_active" | "farms_active" | "ponds_active" | "sensors_active" | "data_export" | "integrations" | "custom";
  totalUsage: number;
  peakUsage: number;
  averageUsage: number;
  eventCount: number;
  unit: string;
}

/** @see apps/admin-api-service/src/billing/services/discount-code.service.ts */
export interface DiscountStats {
  totalCodes: number;
  activeCodes: number;
  expiredCodes: number;
  totalRedemptions: number;
  totalDiscountAmount: number;
  topCodes: Array<{
    code: string;
    redemptions: number;
    totalDiscount: number;
  }>;
}

// ==========================================================================
// modules
// ==========================================================================

/** @see apps/admin-api-service/src/modules/modules.service.ts */
export interface ModuleStats {
  totalModules: number;
  activeModules: number;
  coreModules: number;
  totalAssignments: number;
  moduleUsage: Array<{
    moduleId: string;
    moduleName: string;
    tenantsCount: number;
  }>;
}

/** @see apps/admin-api-service/src/modules/modules.service.ts */
export interface TenantModuleAssignment {
  id: string;
  tenantId: string;
  tenantName: string;
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  assignedAt: string;
  expiresAt: null | string;
  quantities?: ModuleQuantities;
  configuration?: Record<string, unknown>;
}

// ==========================================================================
// users
// ==========================================================================

/** @see apps/admin-api-service/src/users/users.service.ts */
export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  usersByRole: Array<{
    role: string;
    count: number;
  }>;
  usersByTenant: Array<{
    tenantId: string;
    tenantName: string;
    count: number;
  }>;
  newUsersLast30Days: number;
  loginsLast24Hours: number;
}

/** @see libs/event-contracts/src/roles.ts */
export const PLATFORM_ROLE_CODES = [
  "SUPER_ADMIN",
  "TENANT_ADMIN",
  "MODULE_MANAGER",
  "MODULE_USER",
] as const;
export type PlatformRoleCode = (typeof PLATFORM_ROLE_CODES)[number];

/** @see libs/event-contracts/src/roles.ts */
export const INVITABLE_ROLE_CODES = [
  "TENANT_ADMIN",
  "MODULE_MANAGER",
  "MODULE_USER",
] as const;
export type InvitableRoleCode = (typeof INVITABLE_ROLE_CODES)[number];

/** @see apps/admin-api-service/src/users/users.service.ts */
export interface UserDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "SUPER_ADMIN" | "TENANT_ADMIN" | "MODULE_MANAGER" | "MODULE_USER";
  tenantId: null | string;
  tenantName: null | string;
  isActive: boolean;
  lastLoginAt: null | string;
  createdAt: string;
  updatedAt: string;
}

/** @see apps/admin-api-service/src/users/services/role-template.service.ts */
export interface Permission {
  code: string;
  name: string;
  description: string;
  category: string;
}

/** @see apps/admin-api-service/src/users/services/role-template.service.ts */
export interface RoleTemplate {
  code: "SUPER_ADMIN" | "TENANT_ADMIN" | "MODULE_MANAGER" | "MODULE_USER";
  name: string;
  description: string;
  level: number;
  permissions: string[];
  isSystem: boolean;
  color: string;
  icon: string;
}

// ==========================================================================
// system
// ==========================================================================

/** @see apps/admin-api-service/src/metrics/system-metrics.service.ts */
export interface SystemMetrics {
  timestamp: string;
  database: DatabaseMetrics;
  platform: PlatformMetrics;
  resources: ResourceMetrics;
}

/** @see apps/admin-api-service/src/metrics/system-metrics.service.ts */
export interface ServiceHealth {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  responseTime?: number;
  lastCheck: string;
  details?: Record<string, unknown>;
}

/** @see apps/admin-api-service/src/health/health.service.ts */
export type CircuitBreakerStatus = Record<string, CircuitBreakerInfo>;
