/**
 * Security domain types
 */

import type { ApiSchema } from '../contract';

export type SecurityEventSeverity = 'low' | 'medium' | 'high' | 'critical';
export type SecurityEventType =
  | 'failed_login'
  | 'brute_force_attempt'
  | 'suspicious_activity'
  | 'unauthorized_access'
  | 'privilege_escalation'
  | 'data_exfiltration'
  | 'malware_detected'
  | 'api_abuse'
  | 'rate_limit_exceeded'
  | 'sql_injection_attempt'
  | 'xss_attempt'
  | 'csrf_attempt'
  | 'account_lockout'
  | 'password_spray'
  | 'credential_stuffing'
  | 'session_hijacking'
  | 'ip_blacklisted'
  | 'geo_anomaly'
  | 'device_anomaly'
  | 'time_anomaly';

export type ActivityLogCategory =
  | 'user_action'
  | 'system_event'
  | 'api_call'
  | 'data_access'
  | 'security_event'
  | 'configuration'
  | 'authentication';

export type ActivityLogSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';
/**
 * The severities `admin.audit_logs` can hold, derived rather than restated.
 *
 * This union was already RIGHT while `audit.ts` declared the same field as
 * `low | medium | high | critical` and `AuditLogPage` imported that one
 * (ADMIN-HIGH-112). Two hand-written declarations of one column, one correct
 * and one not, is precisely what a contract-sourced type removes.
 */
export type AuditSeverity = ApiSchema<'AuditLog'>['severity'];
export type SecurityEventStatus =
  | 'detected'
  | 'investigating'
  | 'confirmed'
  | 'mitigated'
  | 'false_positive'
  | 'escalated';
export type SecurityIncidentStatus =
  | 'open'
  | 'investigating'
  | 'contained'
  | 'eradicated'
  | 'recovered'
  | 'closed';
export type ThreatIndicatorType =
  | 'ip'
  | 'domain'
  | 'url'
  | 'hash'
  | 'email'
  | 'user_agent'
  | 'cidr';
export type ComplianceType = 'gdpr' | 'ccpa' | 'hipaa' | 'pci_dss' | 'sox' | 'iso27001';
export type DataRequestType =
  | 'access'
  | 'deletion'
  | 'portability'
  | 'rectification'
  | 'restriction';
export type DataRequestStatus = 'pending' | 'in_progress' | 'completed' | 'rejected' | 'expired';

export interface BackendActivityLog {
  id: string;
  category: ActivityLogCategory;
  action: string;
  severity: ActivityLogSeverity;
  tenantId?: string | null;
  tenantName?: string | null;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  geoLocation?: {
    country?: string;
    region?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  } | null;
  location?: { country?: string; city?: string };
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  duration?: number | null;
  success: boolean;
  errorMessage?: string | null;
  createdAt: string;
  timestamp?: string;
}

/**
 * One `admin.audit_logs` row. Identical to {@link AuditLog} in `audit.ts` —
 * both described the same endpoint's response, which is how they came to
 * disagree. Kept as an alias of the same contract schema so the existing
 * imports of this name keep resolving to one shape.
 */
export type BackendAuditLog = ApiSchema<'AuditLog'>;

export interface ActivityStatsOverview {
  totalActivities: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  bySuccess: Record<string, number>;
  topActions: Array<{ action: string; count: number }>;
  topUsers: Array<{ userId: string; userName?: string; count: number }>;
  topIPs: Array<{ ip: string; count: number }>;
  activityOverTime: Array<{ date: string; count: number }>;
}

export interface AuditSummary {
  totalLogs: number;
  last24Hours: number;
  byAction: Array<{ action: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  byEntityType: Array<{ entityType: string; count: number }>;
  topUsers: Array<{ userId: string; email: string; count: number }>;
}

export interface BackendAuditAlertRule {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  conditions: {
    category?: ActivityLogCategory[];
    severity?: ActivityLogSeverity[];
    actions?: string[];
    entityTypes?: string[];
    successOnly?: boolean;
    failureOnly?: boolean;
    ipPatterns?: string[];
  };
  alertChannels: Array<'email' | 'webhook' | 'slack' | 'sms'>;
  recipients: string[];
  cooldownMinutes: number;
  lastTriggeredAt?: string;
}

/**
 * One GDPR/framework requirement — mirrors the backend `ComplianceRequirement`
 * (apps/admin-api-service/src/security/services/compliance.service.ts).
 *
 * The human-readable text lives HERE, nested, not flattened onto the check
 * result. Declaring `requirement` as a string is what put an object into JSX.
 */
export interface BackendComplianceRequirement {
  id: string;
  framework: ComplianceType;
  requirement: string;
  description: string;
  category: string;
  isMandatory: boolean;
  verificationMethod: string;
}

/**
 * The result of running one requirement check — mirrors the backend
 * `ComplianceCheckResult`. Parity is pinned by
 * tests/invariants/admin-security-runtime-contract.spec.ts.
 *
 * There is no `nextReview`: checks execute live per request and the platform
 * has no scheduled-review concept. The panel used to declare one (along with
 * `id`, `category`, `description` and `lastChecked` at the top level), all of
 * which arrived `undefined` and none of which the compiler could question,
 * because `apiFetch<T>`'s generic is an unchecked assertion across the wire.
 */
export interface BackendComplianceCheckResult {
  requirement: BackendComplianceRequirement;
  status: 'compliant' | 'non_compliant' | 'partial' | 'not_applicable';
  details: string;
  evidence?: string;
  remediation?: string;
  checkedAt: string;
}

export interface BackendComplianceReport {
  id: string;
  complianceType: ComplianceType;
  tenantId?: string | null;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  status?: string;
  complianceScore: number;
  violations?: Array<Record<string, unknown>> | null;
  recommendations?: string[] | null;
  /**
   * `generateComplianceReport` stores the check results verbatim into this
   * jsonb column, so `complianceResults` is exactly `ComplianceCheckResult[]`.
   * It was declared as flat optional strings, which made `finding.requirement`
   * read as a string when it is an object — the same crash as the Checks tab,
   * on a report the monthly cron guarantees exists.
   */
  detailedFindings?: {
    complianceResults?: BackendComplianceCheckResult[];
    [key: string]: unknown;
  } | null;
  generatedBy?: string | null;
  generatedByName?: string | null;
  createdAt: string;
  generatedAt?: string;
  updatedAt?: string;
}

export interface BackendDataSubjectRequest {
  id: string;
  requestType: DataRequestType;
  complianceFramework?: ComplianceType;
  status: DataRequestStatus;
  tenantId?: string | null;
  tenantName?: string | null;
  requesterId?: string | null;
  requesterName?: string | null;
  requesterEmail: string;
  description?: string | null;
  dataCategories?: string[] | null;
  dueDate: string;
  assignedTo?: string | null;
  assignedToName?: string | null;
  identityVerified?: boolean;
  verifiedAt?: string | null;
  completedAt?: string | null;
  deliveryFormat?: string | null;
  downloadUrl?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface BackendSecurityEvent {
  id: string;
  eventType: SecurityEventType;
  threatLevel: SecurityEventSeverity;
  status: SecurityEventStatus;
  title: string;
  description: string;
  ipAddress: string;
  geoLocation?: {
    country?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
  } | null;
  tenantId?: string | null;
  userId?: string | null;
  userName?: string | null;
  targetResource?: string | null;
  targetEndpoint?: string | null;
  detectionSource: string;
  confidenceScore?: number | null;
  rawData?: Record<string, unknown> | null;
  assignedTo?: string | null;
  assignedToName?: string | null;
  investigationNotes?: string | null;
  resolution?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface BackendSecurityIncident {
  id: string;
  title: string;
  description: string;
  severity: SecurityEventSeverity;
  status: SecurityIncidentStatus;
  category?: string | null;
  affectedSystems?: string[] | null;
  affectedUsers?: number | null;
  relatedEvents?: string[] | null;
  leadInvestigator?: string | null;
  leadInvestigatorName?: string | null;
  timeline?: Array<{ action: string; timestamp: string; user?: string }> | null;
  impactDescription?: string | null;
  rootCauseAnalysis?: string | null;
  remediation?: string | null;
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string | null;
}

export interface BackendThreatIndicator {
  id: string;
  indicatorType: ThreatIndicatorType;
  value: string;
  threatLevel: SecurityEventSeverity;
  source: string;
  description?: string | null;
  threatTypes?: string[] | null;
  tags?: string[] | null;
  confidence: number;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  hitCount?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface BackendSecurityDashboardStats {
  totalSecurityEvents: number;
  eventsLast24h: number;
  eventsLast7d: number;
  eventsLast30d: number;
  eventsTrend: 'increasing' | 'decreasing' | 'stable';
  criticalEvents: number;
  activeIncidents: number;
  threatsBlocked: number;
  eventsByType: Record<SecurityEventType, number>;
  eventsBySeverity: Record<SecurityEventSeverity, number>;
  topSourceIPs: Array<{ ip: string; count: number; threatLevel: SecurityEventSeverity }>;
  topTargetedUsers: Array<{ userId: string; userName: string; count: number }>;
  topEventTypes: Array<{ type: SecurityEventType; count: number }>;
  eventsTimeline: Array<{
    date: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
  }>;
}

export interface BackendSecurityHealthScore {
  score: number;
  factors: Array<{
    name: string;
    score: number;
    weight: number;
    description: string;
  }>;
  recommendations: string[];
}

/**
 * A retention window in force, as declared in the owning service's retention
 * bootstrap module and enforced by the platform's single registry-driven
 * enforcer (ADR-0012). Read-only: windows are compliance commitments
 * reviewed as code, not settings.
 */
export interface RetentionPolicy {
  id: string;
  ownerTag: string;
  schema: string;
  tableName: string;
  timestampColumn: string;
  retentionDays: number;
  legalHoldAware: boolean;
}
