/**
 * Reports API
 */

import { apiFetchBlob } from '../blob-client';
import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  ReportDefinition,
  ReportExecution,
  ReportFormat,
  ReportStatus,
  ReportType,
  CreateReportDefinitionInput,
  UpdateReportDefinitionInput,
} from '../types';

export const reportsApi = {
  // Report Definitions
  getReportDefinitions: () => apiFetch<ReportDefinition[]>('/reports/definitions'),
  getReportDefinition: (id: string) => apiFetch<ReportDefinition>(`/reports/definitions/${id}`),
  // The payload types are the DTO whitelists, not `Omit<ReportDefinition, …>`:
  // under `forbidNonWhitelisted: true` a read model minus a few keys is a 400,
  // because it still carries `status`, `runCount`, `createdByEmail` and
  // `updatedAt` that the server owns (APA-150).
  createReportDefinition: (data: CreateReportDefinitionInput) =>
    apiFetch<ReportDefinition>('/reports/definitions', { method: 'POST', body: JSON.stringify(data) }),
  updateReportDefinition: (id: string, data: UpdateReportDefinitionInput) =>
    apiFetch<ReportDefinition>(`/reports/definitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteReportDefinition: async (id: string): Promise<void> => {
    await apiFetch<unknown>(`/reports/definitions/${id}`, { method: 'DELETE' });
  },

  // Report Execution
  executeReport: (data: {
    definitionId?: string;
    reportType?: ReportType;
    reportName?: string;
    format: ReportFormat;
    filters?: Record<string, unknown>;
    startDate?: string;
    endDate?: string;
  }) =>
    apiFetch<ReportExecution>('/reports/executions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  generateReport: (definitionId: string, format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/executions', {
      method: 'POST',
      body: JSON.stringify({ definitionId, format, filters }),
    }),
  getReportExecutions: (params?: { definitionId?: string; reportId?: string; status?: ReportStatus; reportType?: ReportType } & PaginationParams) =>
    apiFetch<PaginatedResult<ReportExecution>>(`/reports/executions?${buildQueryString(params || {})}`),
  getReportExecution: (id: string) => apiFetch<ReportExecution>(`/reports/executions/${id}`),
  downloadReport: (executionId: string) =>
    apiFetchBlob(`/reports/executions/${executionId}/download`),

  // Quick Reports
  getTenantsReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/tenants', { method: 'POST', body: JSON.stringify({ format, filters }) }),
  getUsersReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/users', { method: 'POST', body: JSON.stringify({ format, filters }) }),
  getRevenueReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/revenue', { method: 'POST', body: JSON.stringify({ format, filters }) }),
  getAuditReport: (format: ReportFormat, filters?: Record<string, unknown>) =>
    apiFetch<ReportExecution>('/reports/quick/audit', { method: 'POST', body: JSON.stringify({ format, filters }) }),

  // Report Generation & Export (synchronous preview/ad-hoc compatibility only)
  generateCustomReport: (data: { type: string; format: string; startDate?: string; endDate?: string }) =>
    apiFetch<{ data: unknown[]; summary: Record<string, unknown>; metadata?: { generatedAt: string; reportType: string; format: string } }>('/reports/generate', { method: 'POST', body: JSON.stringify(data) }),
};
