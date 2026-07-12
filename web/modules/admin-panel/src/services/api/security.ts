/**
 * Security API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  RetentionPolicy,
  SecurityEventType,
  SecurityEventSeverity,
  SecurityEventStatus,
  BackendActivityLog,
  BackendAuditLog,
  BackendComplianceReport,
  BackendDataSubjectRequest,
  BackendSecurityEvent,
  BackendSecurityIncident,
  BackendThreatIndicator,
  BackendSecurityDashboardStats,
  BackendSecurityHealthScore,
  ActivityStatsOverview,
  AuditSummary,
  BackendAuditAlertRule,
  ThreatIndicatorType,
} from '../types';

const platformScope = { tenantScope: 'platform' as const };

export const securityApi = {
  // Activity Logs
  getActivityLogs: (params?: {
    category?: string;
    severity?: string;
    action?: string;
    entityType?: string;
    userId?: string;
    tenantId?: string;
    ipAddress?: string;
    searchQuery?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<BackendActivityLog>>(`/security/activities?${buildQueryString(params || {})}`, platformScope),
  getActivityLog: (id: string) => apiFetch<BackendActivityLog>(`/security/activities/${id}`, platformScope),
  getEntityActivities: (entityType: string, entityId: string, params?: PaginationParams) =>
    apiFetch<PaginatedResult<BackendActivityLog>>(`/security/activities/entity/${entityType}/${entityId}?${buildQueryString(params || {})}`, platformScope),
  // Audit Trail
  getAuditTrail: (params?: {
    action?: string;
    entityType?: string;
    performedBy?: string;
    severity?: string;
    search?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<BackendAuditLog>>(`/security/audit?${buildQueryString(params || {})}`, platformScope),
  getEntityAuditTrail: (entityType: string, entityId: string) =>
    apiFetch<BackendAuditLog[]>(`/security/audit/entity/${entityType}/${entityId}`, platformScope),

  // Retention Policies
  getRetentionPolicies: () => apiFetch<RetentionPolicy[]>('/security/audit/retention-policies', platformScope),
  createRetentionPolicy: (data: Omit<RetentionPolicy, 'id' | 'lastRunAt' | 'nextRunAt'>) =>
    apiFetch<RetentionPolicy>('/security/audit/retention-policies', { ...platformScope, method: 'POST', body: JSON.stringify(data) }),
  updateRetentionPolicy: (id: string, data: Partial<RetentionPolicy>) =>
    apiFetch<RetentionPolicy>(`/security/audit/retention-policies/${id}`, { ...platformScope, method: 'PUT', body: JSON.stringify(data) }),
  deleteRetentionPolicy: (id: string) =>
    apiFetch<Record<string, never>>(`/security/audit/retention-policies/${id}`, { ...platformScope, method: 'DELETE' }),
  // Fix: backend has POST /security/audit/retention-policies/apply (applies all, no per-policy run)
  runRetentionPolicy: (_id: string) =>
    apiFetch<{ success: boolean }>('/security/audit/retention-policies/apply', { ...platformScope, method: 'POST' }),

  // Compliance
  getComplianceReports: (params?: PaginationParams & { complianceType?: string; tenantId?: string }) =>
    apiFetch<PaginatedResult<BackendComplianceReport>>(`/security/compliance/reports?${buildQueryString(params || {})}`, platformScope),
  // Fix: backend POST /security/compliance/reports (not /reports/generate), body uses complianceType + reportPeriodStart/End
  generateComplianceReport: (complianceType: string, reportPeriodStart?: string, reportPeriodEnd?: string, includedTenants?: string[]) =>
    apiFetch<BackendComplianceReport>('/security/compliance/reports', { ...platformScope, method: 'POST', body: JSON.stringify({ complianceType, reportPeriodStart: reportPeriodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), reportPeriodEnd: reportPeriodEnd || new Date().toISOString(), includedTenants }) }),
  // Data Subject Requests (GDPR)
  getDataRequests: (params?: { status?: string; requestType?: string; searchQuery?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<BackendDataSubjectRequest>>(`/security/compliance/data-requests?${buildQueryString(params || {})}`, platformScope),
  getDataRequest: (id: string) => apiFetch<BackendDataSubjectRequest>(`/security/compliance/data-requests/${id}`, platformScope),
  createDataRequest: (data: Omit<BackendDataSubjectRequest, 'id' | 'status' | 'createdAt' | 'dueDate'>) =>
    apiFetch<BackendDataSubjectRequest>('/security/compliance/data-requests', { ...platformScope, method: 'POST', body: JSON.stringify(data) }),
  // Fix: backend has separate endpoints: POST .../verify and POST .../complete (no single /process)
  // Use PUT to update status, or POST /verify + POST /complete separately
  processDataRequest: (id: string, action: 'approve' | 'reject', _handledBy: string, notes?: string) => {
    if (action === 'approve') {
      return apiFetch<BackendDataSubjectRequest>(`/security/compliance/data-requests/${id}/complete`, {
        ...platformScope,
        method: 'POST',
        body: JSON.stringify({ completionNotes: notes || 'Approved' })
      });
    }
    // For reject, use PUT to update status
    return apiFetch<BackendDataSubjectRequest>(`/security/compliance/data-requests/${id}`, {
      ...platformScope,
      method: 'PUT',
      body: JSON.stringify({ status: 'rejected', rejectionReason: notes })
    });
  },

  /**
   * Verify data subject request identity.
   * Backend: POST /security/compliance/data-requests/:id/verify
   */
  verifyDataRequestIdentity: (id: string, verificationMethod: string) =>
    apiFetch<BackendDataSubjectRequest>(`/security/compliance/data-requests/${id}/verify`, {
      ...platformScope,
      method: 'POST',
      body: JSON.stringify({ verificationMethod }),
    }),

  /**
   * Reject data subject request.
   * Backend: PUT /security/compliance/data-requests/:id with status=rejected
   */
  rejectDataRequest: (id: string, rejectionReason: string) =>
    apiFetch<BackendDataSubjectRequest>(`/security/compliance/data-requests/${id}`, {
      ...platformScope,
      method: 'PUT',
      body: JSON.stringify({ status: 'rejected', rejectionReason }),
    }),

  /**
   * Complete data subject request.
   * Backend: POST /security/compliance/data-requests/:id/complete
   */
  completeDataRequest: (id: string, completionNotes: string, deliveryFormat?: 'json' | 'csv' | 'pdf' | 'xml') =>
    apiFetch<BackendDataSubjectRequest>(`/security/compliance/data-requests/${id}/complete`, {
      ...platformScope,
      method: 'POST',
      body: JSON.stringify({ completionNotes, deliveryFormat }),
    }),

  // Security Events & Incidents
  getSecurityEvents: (params?: {
    eventType?: SecurityEventType;
    threatLevel?: SecurityEventSeverity[];
    status?: SecurityEventStatus;
    searchQuery?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<BackendSecurityEvent>>(`/security/monitoring/events?${buildQueryString(params || {})}`, platformScope),
  getSecurityEvent: (id: string) => apiFetch<BackendSecurityEvent>(`/security/monitoring/events/${id}`, platformScope),
  // Fix: backend uses PUT /security/monitoring/events/:id/status (not POST .../resolve)
  resolveSecurityEvent: (id: string, resolvedBy: string, notes?: string) =>
    apiFetch<BackendSecurityEvent>(`/security/monitoring/events/${id}/status`, { ...platformScope, method: 'PUT', body: JSON.stringify({ status: 'mitigated', resolvedBy, resolution: notes }) }),

  getSecurityIncidents: (params?: { status?: string; severity?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<BackendSecurityIncident>>(`/security/monitoring/incidents?${buildQueryString(params || {})}`, platformScope),
  getSecurityIncident: (id: string) => apiFetch<BackendSecurityIncident>(`/security/monitoring/incidents/${id}`, platformScope),
  updateSecurityIncident: (id: string, data: Partial<BackendSecurityIncident>) =>
    apiFetch<BackendSecurityIncident>(`/security/monitoring/incidents/${id}`, { ...platformScope, method: 'PUT', body: JSON.stringify(data) }),
  // Threat Intelligence
  getThreatIndicators: (params?: { indicatorType?: ThreatIndicatorType; threatLevel?: SecurityEventSeverity; isActive?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<BackendThreatIndicator>>(`/security/monitoring/threat-intelligence?${buildQueryString(params || {})}`, platformScope),
  addThreatIndicator: (data: Omit<BackendThreatIndicator, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt'>) =>
    apiFetch<BackendThreatIndicator>('/security/monitoring/threat-intelligence', { ...platformScope, method: 'POST', body: JSON.stringify(data) }),
  // Security Dashboard (typed by the backend SecurityDashboardStats contract)
  getMonitoringDashboard: () => apiFetch<BackendSecurityDashboardStats>('/security/monitoring/dashboard', platformScope),
  // Health score
  getHealthScore: () => apiFetch<BackendSecurityHealthScore>('/security/monitoring/health-score', platformScope),

  // Audit Summary & Alert Rules
  getAuditSummary: () =>
    apiFetch<AuditSummary>('/security/audit/summary', platformScope),
  getAlertRules: () =>
    apiFetch<BackendAuditAlertRule[]>('/security/audit/alert-rules', platformScope),

  // Activity Stats
  getActivityStatsOverview: () =>
    apiFetch<ActivityStatsOverview>('/security/activities/stats/overview', platformScope),

  // Compliance Checks
  getComplianceChecks: (framework: string) =>
    apiFetch<Array<{ id: string; category: string; requirement: string; description: string; status: string; evidence?: string; lastChecked: string; nextReview: string }>>(`/security/compliance/checks/${framework}`, platformScope),
};
