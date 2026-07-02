/**
 * Persisted regulatory report submission hooks (FARM-HIGH-112)
 *
 * Reads the `regulatory_reports` record-of-submission the backend now
 * persists for every Mattilsynet report type. These hooks replace the
 * mock arrays the report-history tabs used to render.
 *
 * Follows the module data-layer conventions: useAuth() for
 * token/tenantId, graphqlClient.request(), tenant-scoped query keys.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, graphqlClient, createTenantQueryKey, createTenantInvalidationKey } from '@aquaculture/shared-ui';
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
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'regulatoryReports', reportType, siteId, limit),
    queryFn: async (): Promise<RegulatoryReportRow[]> => {
      const data = await graphqlClient.request<{ regulatoryReports: RegulatoryReportRow[] }>(
        REGULATORY_REPORTS_QUERY,
        { reportType, siteId, limit, offset: 0 },
      );
      return data.regulatoryReports;
    },
    enabled: !!token && !!tenantId,
  });
}

export function useRegulatoryReport(id: string | null) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'regulatoryReport', id),
    queryFn: async (): Promise<RegulatoryReportDetail | null> => {
      const data = await graphqlClient.request<{ regulatoryReport: RegulatoryReportDetail | null }>(
        REGULATORY_REPORT_QUERY,
        { id },
      );
      return data.regulatoryReport;
    },
    enabled: !!token && !!tenantId && !!id,
  });
}

export function useRegulatoryReportSummary(siteId?: string) {
  const { token, tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'regulatoryReportSummary', siteId),
    queryFn: async (): Promise<RegulatoryReportTypeSummary[]> => {
      const data = await graphqlClient.request<{
        regulatoryReportSummary: RegulatoryReportTypeSummary[];
      }>(REGULATORY_REPORT_SUMMARY_QUERY, { siteId });
      return data.regulatoryReportSummary;
    },
    enabled: !!token && !!tenantId,
  });
}

/**
 * Invalidate the submission-history caches after a submit mutation —
 * called from the useSubmit* onSuccess handlers so a fresh submission
 * appears in the list without a manual refresh.
 */
export function useInvalidateRegulatoryReports(): () => void {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'regulatoryReports'),
    });
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'regulatoryReportSummary'),
    });
  };
}
