/**
 * Security API
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  ActivityLog,
  AuditTrailEntry,
  RetentionPolicy,
  ComplianceReport,
  DataSubjectRequest,
  SecurityEvent,
  SecurityEventType,
  SecurityEventSeverity,
  SecurityIncident,
  ThreatIndicator,
} from '../types';

export const securityApi = {
  // Activity Logs
  getActivityLogs: (params?: {
    action?: string;
    entityType?: string;
    userId?: string;
    tenantId?: string;
    ipAddress?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<ActivityLog>>(`/security/activities?${buildQueryString(params || {})}`),
  getActivityLog: (id: string) => apiFetch<ActivityLog>(`/security/activities/${id}`),
  getUserActivities: (userId: string, params?: PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<ActivityLog>>(`/security/activities/user/${userId}?${buildQueryString(params || {})}`),
  getEntityActivities: (entityType: string, entityId: string, params?: PaginationParams) =>
    apiFetch<PaginatedResult<ActivityLog>>(`/security/activities/entity/${entityType}/${entityId}?${buildQueryString(params || {})}`),
  // TODO: No GET export on activities. Backend has POST /security/audit/export with body { format, startDate, endDate }
  exportActivityLogs: (_format: 'csv' | 'json', _params?: DateRangeParams) => {
    throw new Error('Not implemented: no backend GET endpoint for /security/activities/export. Use POST /security/audit/export instead.');
  },

  // Audit Trail
  getAuditTrail: (params?: {
    entityType?: string;
    performedBy?: string;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<AuditTrailEntry>>(`/security/audit?${buildQueryString(params || {})}`),
  getEntityAuditTrail: (entityType: string, entityId: string) =>
    apiFetch<AuditTrailEntry[]>(`/security/audit/entity/${entityType}/${entityId}`),

  // Retention Policies
  getRetentionPolicies: () => apiFetch<RetentionPolicy[]>('/security/audit/retention-policies'),
  createRetentionPolicy: (data: Omit<RetentionPolicy, 'id' | 'lastRunAt' | 'nextRunAt'>) =>
    apiFetch<RetentionPolicy>('/security/audit/retention-policies', { method: 'POST', body: JSON.stringify(data) }),
  updateRetentionPolicy: (id: string, data: Partial<RetentionPolicy>) =>
    apiFetch<RetentionPolicy>(`/security/audit/retention-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRetentionPolicy: (id: string) =>
    apiFetch<void>(`/security/audit/retention-policies/${id}`, { method: 'DELETE' }),
  // Fix: backend has POST /security/audit/retention-policies/apply (applies all, no per-policy run)
  runRetentionPolicy: (_id: string) =>
    apiFetch<{ success: boolean }>('/security/audit/retention-policies/apply', { method: 'POST' }),

  // Compliance
  getComplianceReports: () => apiFetch<ComplianceReport[]>('/security/compliance/reports'),
  // Fix: backend POST /security/compliance/reports (not /reports/generate), body uses complianceType + reportPeriodStart/End
  generateComplianceReport: (complianceType: string, reportPeriodStart?: string, reportPeriodEnd?: string, includedTenants?: string[]) =>
    apiFetch<ComplianceReport>('/security/compliance/reports', { method: 'POST', body: JSON.stringify({ complianceType, reportPeriodStart: reportPeriodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), reportPeriodEnd: reportPeriodEnd || new Date().toISOString(), includedTenants }) }),
  // TODO: No backend endpoint for /security/compliance/dashboard - use checks and reports instead
  getComplianceDashboard: () => {
    throw new Error('Not implemented: no backend endpoint for /security/compliance/dashboard. Use getComplianceChecks() and getComplianceReports() instead.');
  },

  // Data Subject Requests (GDPR)
  getDataRequests: (params?: { status?: string; type?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<DataSubjectRequest>>(`/security/compliance/data-requests?${buildQueryString(params || {})}`),
  getDataRequest: (id: string) => apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}`),
  createDataRequest: (data: Omit<DataSubjectRequest, 'id' | 'status' | 'requestedAt' | 'dueDate'>) =>
    apiFetch<DataSubjectRequest>('/security/compliance/data-requests', { method: 'POST', body: JSON.stringify(data) }),
  // Fix: backend has separate endpoints: POST .../verify and POST .../complete (no single /process)
  // Use PUT to update status, or POST /verify + POST /complete separately
  processDataRequest: (id: string, action: 'approve' | 'reject', _handledBy: string, notes?: string) => {
    if (action === 'approve') {
      return apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ completionNotes: notes || 'Approved' })
      });
    }
    // For reject, use PUT to update status
    return apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'rejected', rejectionReason: notes })
    });
  },

  // Security Events & Incidents
  getSecurityEvents: (params?: {
    type?: SecurityEventType[];
    severity?: SecurityEventSeverity[];
    isResolved?: boolean;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<SecurityEvent>>(`/security/monitoring/events?${buildQueryString(params || {})}`),
  getSecurityEvent: (id: string) => apiFetch<SecurityEvent>(`/security/monitoring/events/${id}`),
  // Fix: backend uses PUT /security/monitoring/events/:id/status (not POST .../resolve)
  resolveSecurityEvent: (id: string, resolvedBy: string, notes?: string) =>
    apiFetch<SecurityEvent>(`/security/monitoring/events/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'resolved', resolvedBy, resolution: notes }) }),

  getSecurityIncidents: (params?: { status?: string; severity?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<SecurityIncident>>(`/security/monitoring/incidents?${buildQueryString(params || {})}`),
  getSecurityIncident: (id: string) => apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}`),
  // TODO: No backend POST endpoint for creating incidents - incidents are auto-created from security events
  createSecurityIncident: (_data: Omit<SecurityIncident, 'id' | 'timeline' | 'createdAt'>) => {
    throw new Error('Not implemented: incidents are auto-created from security events, no POST /incidents endpoint');
  },
  updateSecurityIncident: (id: string, data: Partial<SecurityIncident>) =>
    apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  // TODO: No backend endpoint for adding timeline entries directly
  addIncidentTimeline: (_id: string, _action: string, _performedBy: string) => {
    throw new Error('Not implemented: no backend endpoint for POST /incidents/:id/timeline');
  },

  // Threat Intelligence
  getThreatIndicators: (params?: { type?: string; isBlocked?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<ThreatIndicator>>(`/security/monitoring/threat-intelligence?${buildQueryString(params || {})}`),
  addThreatIndicator: (data: Omit<ThreatIndicator, 'id' | 'lastSeenAt' | 'createdAt'>) =>
    apiFetch<ThreatIndicator>('/security/monitoring/threat-intelligence', { method: 'POST', body: JSON.stringify(data) }),
  // TODO: No backend endpoint for blocking/unblocking individual threat indicators
  blockThreatIndicator: (_id: string) => {
    throw new Error('Not implemented: no backend endpoint for POST /threat-intelligence/:id/block');
  },
  unblockThreatIndicator: (_id: string) => {
    throw new Error('Not implemented: no backend endpoint for POST /threat-intelligence/:id/unblock');
  },

  // Security Dashboard
  getSecurityDashboard: () =>
    apiFetch<{
      threatLevel: SecurityEventSeverity;
      activeIncidents: number;
      unresolvedEvents: number;
      blockedThreats: number;
      recentEvents: SecurityEvent[];
      topThreats: Array<{ type: string; count: number }>;
    }>('/security/monitoring/dashboard'),
  // Full monitoring dashboard data
  getMonitoringDashboard: () => apiFetch<unknown>('/security/monitoring/dashboard'),
  // Health score
  getHealthScore: () => apiFetch<{ score: number; status: string; details: unknown[] }>('/security/monitoring/health-score'),

  // Audit Summary & Alert Rules
  getAuditSummary: () =>
    apiFetch<{ totalEntries: number; byAction: Record<string, number>; bySeverity: Record<string, number>; byEntityType: Record<string, number>; last24Hours: number; last7Days: number; retentionPoliciesCount: number; alertRulesCount: number }>('/security/audit/summary'),
  getAlertRules: () =>
    apiFetch<Array<{ id: string; name: string; condition: string; threshold?: number; actions: string[]; severity: string; enabled: boolean; triggeredCount: number; lastTriggered?: string; createdAt: string }>>('/security/audit/alert-rules'),

  // Activity Stats
  getActivityStatsOverview: () =>
    apiFetch<{ totalActivities: number; byCategory: Record<string, number>; bySeverity: Record<string, number>; uniqueUsers: number; uniqueIps: number; averageResponseTime: number; errorRate: number }>('/security/activities/stats/overview'),

  // Compliance Checks
  getComplianceChecks: (framework: string) =>
    apiFetch<Array<{ id: string; category: string; requirement: string; description: string; status: string; evidence?: string; lastChecked: string; nextReview: string }>>(`/security/compliance/checks/${framework}`),
};
