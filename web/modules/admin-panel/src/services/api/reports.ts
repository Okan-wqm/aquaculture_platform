/**
 * Reports API
 */

import { apiFetch, apiFetchBlob } from '../http-client';
import type {
  ReportDefinitionDto,
  ReportFormat,
  ReportType,
} from '../types';
import {
  ADMIN_API_ROUTES,
  ADMIN_BINARY_ROUTES,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type ReportDefinitionsQuery = AdminApiRouteQuery<'GET /reports/definitions'>;
type ReportExecutionsQuery = AdminApiRouteQuery<'GET /reports/executions'>;

export const reportsApi = {
  getReportCapabilities: () =>
    apiFetch(ADMIN_API_ROUTES['GET /reports/capabilities']),

  // Report Definitions
  getReportDefinitions: (query: ReportDefinitionsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /reports/definitions'], {
      query,
    }),
  getReportDefinition: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /reports/definitions/:id'], { path: { id: id } }),
  createReportDefinition: (
    data: Omit<
      ReportDefinitionDto,
      'id' | 'createdBy' | 'createdByEmail' | 'createdAt' | 'updatedAt'
    >,
  ) => apiFetch(ADMIN_API_ROUTES['POST /reports/definitions'], { body: data }),
  updateReportDefinition: (id: string, data: Partial<ReportDefinitionDto>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /reports/definitions/:id'], { path: { id: id }, body: data }),
  deleteReportDefinition: async (id: string): Promise<void> => {
    await apiFetch(ADMIN_API_ROUTES['DELETE /reports/definitions/:id'], { path: { id: id } });
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
  }) => apiFetch(ADMIN_API_ROUTES['POST /reports/executions'], { body: data }),
  getReportExecutions: (query: ReportExecutionsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /reports/executions'], { query }),
  getReportExecution: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /reports/executions/:id'], { path: { id: id } }),
  downloadReport: (executionId: string) =>
    apiFetchBlob(ADMIN_BINARY_ROUTES['GET /reports/executions/:id/download'], {
      path: { id: executionId },
    }),
};
