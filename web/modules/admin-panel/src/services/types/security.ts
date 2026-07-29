/**
 * Security domain types.
 *
 * The read shapes and vocabularies are GENERATED
 * (`tools/codegen/admin-contracts/manifest.ts`).
 *
 * Six of them used to be hand-written here under a `Backend*` prefix. That
 * prefix was never a namespace — it meant "the backend's version of this, as
 * opposed to ours", and having both was the defect. The prefix is gone with the
 * copies it distinguished. So are five duplicate vocabularies:
 * `SecurityEventSeverity` restated `ThreatLevel`, `ActivityLogCategory` restated
 * `ActivityCategory`, `ActivityLogSeverity` restated `ActivitySeverity`,
 * `SecurityIncidentStatus` restated `IncidentStatus`, and `ThreatIndicatorType`
 * restated a union that existed only inline on the entity column until it was
 * named. The panel keeps the old names as aliases so no call site had to change.
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  AuditSummary,
  AuditSeverity,
  ComplianceType,
  DataRequestStatus,
  DataRequestType,
  SecurityEventStatus,
  SecurityEventType,
  ActivityLog,
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  SecurityDashboardStats,
  SecurityEventStats,
  IncidentStats,
  ThreatIntelStats,
  ThreatCheckResult,
  SecurityHealthScore,
  SecurityHealthFactor,
  SecurityTelemetryStatus,
  ThreatLevel,
  ThreatIndicatorType,
  IncidentSeverity,
  IncidentStatus,
  ActivityCategory,
  ActivitySeverity,
} from './generated/admin-contracts';

export type {
  AuditSummary,
  AuditSeverity,
  ComplianceType,
  DataRequestStatus,
  DataRequestType,
  SecurityEventStatus,
  SecurityEventType,
  ActivityLog,
  SecurityEvent,
  SecurityIncident,
  ThreatIntelligence,
  SecurityDashboardStats,
  SecurityEventStats,
  IncidentStats,
  ThreatIntelStats,
  ThreatCheckResult,
  SecurityHealthScore,
  SecurityHealthFactor,
  SecurityTelemetryStatus,
  ThreatLevel,
  ThreatIndicatorType,
  IncidentSeverity,
  IncidentStatus,
};

// The panel's historical names for the vocabularies above, kept as ALIASES so
// existing call sites resolve. Each of these was a second declaration.
export type SecurityEventSeverity = ThreatLevel;
export type ActivityLogCategory = ActivityCategory;
export type ActivityLogSeverity = ActivitySeverity;
export type SecurityIncidentStatus = IncidentStatus;

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
 * The compliance-check contract is GENERATED from
 * `apps/admin-api-service/src/security/services/compliance.service.ts` and
 * aliased under the panel's `Backend*` naming.
 *
 * Hand-declared, it claimed `requirement` was a string when the backend sends a
 * nested object, and invented `id`/`category`/`description`/`lastChecked`/
 * `nextReview` at the top level. Spreading that row put the object into JSX and
 * crashed the page. Deriving the type is what makes that unrepresentable.
 */
import type {
  ComplianceRequirement as BackendComplianceRequirement,
  ComplianceCheckResult as BackendComplianceCheckResult,
} from './generated/admin-contracts';

export type { BackendComplianceRequirement, BackendComplianceCheckResult };

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
