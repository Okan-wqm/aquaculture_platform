/**
 * Persisted regulatory report submission hooks (FARM-HIGH-125)
 *
 * Reads the `regulatory_reports` record-of-submission the backend now
 * persists for every Mattilsynet report type. These hooks replace the
 * mock arrays the report-history tabs used to render.
 *
 * Follows the module data-layer conventions: useTenantQuery (the
 * tenant-key + auth-gate + keepPreviousData SSoT) over graphqlClient.
 */
import { graphqlClient, useTenantQuery } from '@aquaculture/shared-ui';
import {
  REGULATORY_REPORTS_QUERY,
  REGULATORY_REPORT_QUERY,
  REGULATORY_REPORT_SUMMARY_QUERY,
} from '../graphql/regulatory.operations';

// ============================================================================
// TYPES — mirror apps/farm-service regulatory-report.entity.ts
// ============================================================================

export type RegulatoryReportTypeValue =
  | 'SEA_LICE'
  | 'CLEANER_FISH'
  | 'SMOLT'
  | 'SLAUGHTER_PLANNED'
  | 'SLAUGHTER_EXECUTED'
  | 'WELFARE_EVENT'
  | 'ESCAPE'
  | 'DISEASE_OUTBREAK';

export type RegulatoryReportStatusValue = 'PENDING' | 'SUBMITTED' | 'QUEUED' | 'FAILED';

export interface RegulatoryReportRow {
  id: string;
  reportType: RegulatoryReportTypeValue;
  klientReferanse: string;
  siteId?: string | null;
  lokalitetsnummer: number;
  reportYear?: number | null;
  reportWeek?: number | null;
  reportMonth?: number | null;
  status: RegulatoryReportStatusValue;
  referanse?: string | null;
  feilmelding?: string | null;
  submittedBy: string;
  submittedAt?: string | null;
  createdAt: string;
}

export interface RegulatoryReportDetail extends RegulatoryReportRow {
  payload: Record<string, unknown>;
}

export interface RegulatoryReportTypeSummary {
  reportType: RegulatoryReportTypeValue;
  pendingCount: number;
  submittedCount: number;
  queuedCount: number;
  failedCount: number;
  lastSubmittedAt?: string | null;
}

// ============================================================================
// HOOKS
// ============================================================================

export function useRegulatoryReports(
  reportType: RegulatoryReportTypeValue,
  siteId?: string,
  limit = 50,
) {
  return useTenantQuery<RegulatoryReportRow[]>(
    ['regulatoryReports', reportType, siteId, limit],
    async () => {
      const data = await graphqlClient.request<{ regulatoryReports: RegulatoryReportRow[] }>(
        REGULATORY_REPORTS_QUERY,
        { reportType, siteId, limit, offset: 0 },
      );
      return data.regulatoryReports;
    },
  );
}

export function useRegulatoryReport(id: string | null) {
  return useTenantQuery<RegulatoryReportDetail | null>(
    ['regulatoryReport', id],
    async () => {
      const data = await graphqlClient.request<{ regulatoryReport: RegulatoryReportDetail | null }>(
        REGULATORY_REPORT_QUERY,
        { id },
      );
      return data.regulatoryReport;
    },
    { enabled: !!id },
  );
}

export function useRegulatoryReportSummary(siteId?: string) {
  return useTenantQuery<RegulatoryReportTypeSummary[]>(
    ['regulatoryReportSummary', siteId],
    async () => {
      const data = await graphqlClient.request<{
        regulatoryReportSummary: RegulatoryReportTypeSummary[];
      }>(REGULATORY_REPORT_SUMMARY_QUERY, { siteId });
      return data.regulatoryReportSummary;
    },
  );
}

