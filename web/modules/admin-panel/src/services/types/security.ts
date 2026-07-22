/**
 * Security domain types
 */

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
export type AuditSeverity = 'info' | 'warning' | 'critical';
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
export type DataRequestType = 'access' | 'deletion' | 'portability' | 'rectification' | 'restriction';
// Mirrors the backend DataRequestStatus vocabulary (security.entity.ts /
// admin.data_requests CHECK); kept in lockstep by
// tests/invariants/admin-data-request-status-vocab.spec.ts (APA-236). The
// runtime array drives the CompliancePage status filter so it can't drift.
export const DATA_REQUEST_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'rejected',
  'expired',
] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

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

export interface BackendAuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  tenantId?: string | null;
  performedBy: string;
  performedByEmail?: string | null;
  ipAddress?: string | null;
  details?: Record<string, unknown> | null;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  severity: AuditSeverity;
  requestId?: string | null;
  sessionId?: string | null;
  createdAt: string;
  legalHold?: boolean;
}

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
  detailedFindings?: {
    complianceResults?: Array<{
      category?: string;
      requirement?: string;
      status?: string;
      description?: string;
      recommendation?: string;
    }>;
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
  /**
   * APA-240: telemetry liveness. The security tables the score aggregates over
   * (security_events / login_attempts / api_usage_logs / user_sessions) can be
   * empty, in which case the arithmetic still yields a high "healthy" number.
   * When this is not 'live', the gauge MUST render "No telemetry" instead of a
   * green score — a monitoring surface must not fabricate assurance over a void.
   */
  dataStatus: 'live' | 'stale' | 'no_data';
  lastSeenAt: string | null;
  factors: Array<{
    name: string;
    score: number;
    weight: number;
    description: string;
  }>;
  recommendations: string[];
}

export interface RetentionPolicy {
  id: string;
  name: string;
  entityType?: string;
  category?: string;
  description?: string | null;
  retentionDays: number;
  archiveAfterDays?: number;
  deleteAfterArchiveDays?: number | null;
  isGlobal?: boolean;
  specificTenants?: string[] | null;
  complianceFrameworks?: string[] | null;
  isActive: boolean;
  createdBy?: string;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
}
