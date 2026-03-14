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
  exportActivityLogs: (format: 'csv' | 'json', params?: DateRangeParams) =>
    apiFetch<{ url: string }>(`/security/activities/export?format=${format}&${buildQueryString(params || {})}`),

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
  runRetentionPolicy: (id: string) =>
    apiFetch<{ deletedCount: number; archivedCount: number }>(`/security/audit/retention-policies/${id}/run`, { method: 'POST' }),

  // Compliance
  getComplianceReports: () => apiFetch<ComplianceReport[]>('/security/compliance/reports'),
  generateComplianceReport: (type: string) =>
    apiFetch<ComplianceReport>('/security/compliance/reports/generate', { method: 'POST', body: JSON.stringify({ type }) }),
  getComplianceDashboard: () =>
    apiFetch<{ overallScore: number; byArea: Array<{ area: string; score: number; status: string }> }>('/security/compliance/dashboard'),

  // Data Subject Requests (GDPR)
  getDataRequests: (params?: { status?: string; type?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<DataSubjectRequest>>(`/security/compliance/data-requests?${buildQueryString(params || {})}`),
  getDataRequest: (id: string) => apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}`),
  createDataRequest: (data: Omit<DataSubjectRequest, 'id' | 'status' | 'requestedAt' | 'dueDate'>) =>
    apiFetch<DataSubjectRequest>('/security/compliance/data-requests', { method: 'POST', body: JSON.stringify(data) }),
  processDataRequest: (id: string, action: 'approve' | 'reject', handledBy: string, notes?: string) =>
    apiFetch<DataSubjectRequest>(`/security/compliance/data-requests/${id}/process`, {
      method: 'POST',
      body: JSON.stringify({ action, handledBy, notes })
    }),

  // Security Events & Incidents
  getSecurityEvents: (params?: {
    type?: SecurityEventType[];
    severity?: SecurityEventSeverity[];
    isResolved?: boolean;
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<SecurityEvent>>(`/security/monitoring/events?${buildQueryString(params || {})}`),
  getSecurityEvent: (id: string) => apiFetch<SecurityEvent>(`/security/monitoring/events/${id}`),
  resolveSecurityEvent: (id: string, resolvedBy: string, notes?: string) =>
    apiFetch<SecurityEvent>(`/security/monitoring/events/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolvedBy, notes }) }),

  getSecurityIncidents: (params?: { status?: string; severity?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<SecurityIncident>>(`/security/monitoring/incidents?${buildQueryString(params || {})}`),
  getSecurityIncident: (id: string) => apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}`),
  createSecurityIncident: (data: Omit<SecurityIncident, 'id' | 'timeline' | 'createdAt'>) =>
    apiFetch<SecurityIncident>('/security/monitoring/incidents', { method: 'POST', body: JSON.stringify(data) }),
  updateSecurityIncident: (id: string, data: Partial<SecurityIncident>) =>
    apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  addIncidentTimeline: (id: string, action: string, performedBy: string) =>
    apiFetch<SecurityIncident>(`/security/monitoring/incidents/${id}/timeline`, { method: 'POST', body: JSON.stringify({ action, performedBy }) }),

  // Threat Intelligence
  getThreatIndicators: (params?: { type?: string; isBlocked?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<ThreatIndicator>>(`/security/monitoring/threat-intelligence?${buildQueryString(params || {})}`),
  addThreatIndicator: (data: Omit<ThreatIndicator, 'id' | 'lastSeenAt' | 'createdAt'>) =>
    apiFetch<ThreatIndicator>('/security/monitoring/threat-intelligence', { method: 'POST', body: JSON.stringify(data) }),
  blockThreatIndicator: (id: string) =>
    apiFetch<ThreatIndicator>(`/security/monitoring/threat-intelligence/${id}/block`, { method: 'POST' }),
  unblockThreatIndicator: (id: string) =>
    apiFetch<ThreatIndicator>(`/security/monitoring/threat-intelligence/${id}/unblock`, { method: 'POST' }),

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
