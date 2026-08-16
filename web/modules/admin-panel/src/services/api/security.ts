/**
 * Security API
 */

import { apiFetch } from '../http-client';
import type {
  StandardPaginatedResult,
  PaginationParams,
  DateRangeParams,
  SecurityEventType,
  SecurityEventSeverity,
  SecurityEventStatus,
  ComplianceCheckResultDto,
  ComplianceReportDto,
  DataRequestDto,
  SecurityDashboardStatsDto,
  SecurityEventDto,
  SecurityHealthScoreDto,
  SecurityIncidentDto,
  ThreatIntelligenceDto,
  ThreatIndicatorType,
} from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
  type AdminApiRoutePath,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type ComplianceReportsQuery = AdminApiRouteQuery<'GET /security/compliance/reports'>;
type GenerateComplianceReportInput = AdminApiRouteBody<'POST /security/compliance/reports'>;
type DataRequestsQuery = AdminApiRouteQuery<'GET /security/compliance/data-requests'>;
type CreateDataRequestInput = AdminApiRouteBody<'POST /security/compliance/data-requests'>;
type SecurityIncidentsQuery = AdminApiRouteQuery<'GET /security/monitoring/incidents'>;
type UpdateSecurityIncidentInput = AdminApiRouteBody<'PUT /security/monitoring/incidents/:id'>;
type AddThreatIndicatorInput = AdminApiRouteBody<'POST /security/monitoring/threat-intelligence'>;
type ComplianceCheckPath = AdminApiRoutePath<'GET /security/compliance/checks/:framework'>;

export const securityApi = {
  // Compliance
  getComplianceReports: (params: ComplianceReportsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/compliance/reports'], { query: params }),
  // Fix: backend POST /security/compliance/reports (not /reports/generate), body uses complianceType + reportPeriodStart/End
  generateComplianceReport: (
    complianceType: GenerateComplianceReportInput['complianceType'],
    reportPeriodStart?: string,
    reportPeriodEnd?: string,
    includedTenants?: string[],
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /security/compliance/reports'], {
      body: {
        complianceType,
        reportPeriodStart:
          reportPeriodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        reportPeriodEnd: reportPeriodEnd || new Date().toISOString(),
        includedTenants,
      },
    }),
  // Data Subject Requests (GDPR)
  getDataRequests: (params: DataRequestsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/compliance/data-requests'], { query: params }),
  getDataRequest: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/compliance/data-requests/:id'], { path: { id: id } }),
  createDataRequest: (data: CreateDataRequestInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /security/compliance/data-requests'], { body: data }),
  // Fix: backend has separate endpoints: POST .../verify and POST .../complete (no single /process)
  // Use PUT to update status, or POST /verify + POST /complete separately
  processDataRequest: (
    id: string,
    action: 'approve' | 'reject',
    _handledBy: string,
    notes?: string,
  ) => {
    if (action === 'approve') {
      return apiFetch(ADMIN_API_ROUTES['POST /security/compliance/data-requests/:id/complete'], {
        path: { id: id },
        body: { completionNotes: notes || 'Approved' },
      });
    }
    // For reject, use PUT to update status
    return apiFetch(ADMIN_API_ROUTES['PUT /security/compliance/data-requests/:id'], {
      path: { id: id },
      body: { status: 'rejected', rejectionReason: notes },
    });
  },

  /**
   * Verify data subject request identity.
   * Backend: POST /security/compliance/data-requests/:id/verify
   */
  verifyDataRequestIdentity: (id: string, verificationMethod: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /security/compliance/data-requests/:id/verify'], {
      path: { id: id },
      body: { verificationMethod },
    }),

  /**
   * Reject data subject request.
   * Backend: PUT /security/compliance/data-requests/:id with status=rejected
   */
  rejectDataRequest: (id: string, rejectionReason: string) =>
    apiFetch(ADMIN_API_ROUTES['PUT /security/compliance/data-requests/:id'], {
      path: { id: id },
      body: { status: 'rejected', rejectionReason },
    }),

  /**
   * Complete data subject request.
   * Backend: POST /security/compliance/data-requests/:id/complete
   */
  completeDataRequest: (
    id: string,
    completionNotes: string,
    deliveryFormat?: 'json' | 'csv' | 'pdf' | 'xml',
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /security/compliance/data-requests/:id/complete'], {
      path: { id: id },
      body: { completionNotes, deliveryFormat },
    }),

  // Security Events & Incidents
  getSecurityEvents: (
    params?: {
      eventType?: SecurityEventType;
      threatLevel?: SecurityEventSeverity[];
      status?: SecurityEventStatus;
      searchQuery?: string;
    } & PaginationParams &
      DateRangeParams,
  ) => apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/events'], { query: params || {} }),
  getSecurityEvent: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/events/:id'], { path: { id: id } }),
  // Fix: backend uses PUT /security/monitoring/events/:id/status (not POST .../resolve)
  resolveSecurityEvent: (id: string, resolvedBy: string, notes?: string) =>
    apiFetch(ADMIN_API_ROUTES['PUT /security/monitoring/events/:id/status'], {
      path: { id: id },
      body: { status: 'mitigated', resolvedBy, resolution: notes },
    }),

  getSecurityIncidents: (params: SecurityIncidentsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/incidents'], { query: params }),
  getSecurityIncident: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/incidents/:id'], { path: { id: id } }),
  updateSecurityIncident: (id: string, data: UpdateSecurityIncidentInput) =>
    apiFetch(ADMIN_API_ROUTES['PUT /security/monitoring/incidents/:id'], {
      path: { id: id },
      body: data,
    }),
  // Threat Intelligence
  getThreatIndicators: (
    params?: {
      indicatorType?: ThreatIndicatorType;
      threatLevel?: SecurityEventSeverity;
      isActive?: boolean;
    } & PaginationParams,
  ) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/threat-intelligence'], {
      query: params || {},
    }),
  addThreatIndicator: (data: AddThreatIndicatorInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /security/monitoring/threat-intelligence'], { body: data }),
  // Security dashboard
  getMonitoringDashboard: () =>
    apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/dashboard'], {}),
  // Health score
  getHealthScore: () => apiFetch(ADMIN_API_ROUTES['GET /security/monitoring/health-score'], {}),

  // Compliance Checks
  getComplianceChecks: (framework: ComplianceCheckPath['framework']) =>
    apiFetch(ADMIN_API_ROUTES['GET /security/compliance/checks/:framework'], {
      path: { framework: framework },
    }),
};
