/**
 * Scheduled report-draft hooks (RPT-003) — the Reports-due view's data layer.
 *
 * `reportDeadlines` returns the tenant's non-terminal scheduled drafts with the
 * deadline resolved server-side in the Oslo calendar (overdue + daysUntilDue),
 * so the UI never re-derives the deadline from a local clock. The lifecycle
 * mutations (refresh / approve & submit / dismiss) drive the draft to its next
 * state and invalidate the list. Follows the module data-layer conventions:
 * useTenantQuery / useTenantMutation over graphqlClient.
 */
import { graphqlClient, useTenantMutation, useTenantQuery } from '@aquaculture/shared-ui';

import {
  APPROVE_AND_SUBMIT_REPORT_DRAFT_MUTATION,
  DISMISS_REPORT_DRAFT_MUTATION,
  REFRESH_REPORT_DRAFT_MUTATION,
  REPORT_DEADLINES_QUERY,
} from '../graphql/regulatory-drafts.operations';

// ============================================================================
// TYPES (mirror apps/farm-service dto/regulatory-report-draft.dto.ts)
// ============================================================================

export type ReportDraftStatusValue = 'draft' | 'ready' | 'approved' | 'submitted' | 'dismissed';

export interface ReportDeadline {
  id: string;
  reportType: string;
  siteId: string;
  periodYear: number;
  periodWeek?: number | null;
  periodMonth?: number | null;
  status: ReportDraftStatusValue;
  dueAt?: string | null;
  overdue: boolean;
  daysUntilDue?: number | null;
}

export interface ReportValidationError {
  felt: string;
  melding: string;
}

export interface ReportSubmissionResult {
  success: boolean;
  reportId?: string | null;
  referanse?: string | null;
  klientReferanse?: string | null;
  feilmelding?: string | null;
  valideringsfeil?: ReportValidationError[] | null;
}

// ============================================================================
// HOOKS
// ============================================================================

export function useReportDeadlines() {
  return useTenantQuery<ReportDeadline[]>(['reportDeadlines'], async () => {
    const data = await graphqlClient.request<{ reportDeadlines: ReportDeadline[] }>(
      REPORT_DEADLINES_QUERY,
    );
    return data.reportDeadlines;
  });
}

export function useApproveAndSubmitReportDraft() {
  return useTenantMutation<ReportSubmissionResult, Error, string>(
    async (draftId: string) => {
      const data = await graphqlClient.request<{
        approveAndSubmitReportDraft: ReportSubmissionResult;
      }>(APPROVE_AND_SUBMIT_REPORT_DRAFT_MUTATION, { draftId });
      return data.approveAndSubmitReportDraft;
    },
    // A submission also writes a regulatory_reports receipt row.
    { invalidate: [['reportDeadlines'], ['regulatoryReports'], ['regulatoryReportSummary']] },
  );
}

export function useRefreshReportDraft() {
  return useTenantMutation<{ id: string; status: ReportDraftStatusValue }, Error, string>(
    async (draftId: string) => {
      const data = await graphqlClient.request<{
        refreshReportDraft: { id: string; status: ReportDraftStatusValue };
      }>(REFRESH_REPORT_DRAFT_MUTATION, { draftId });
      return data.refreshReportDraft;
    },
    { invalidate: [['reportDeadlines']] },
  );
}

export function useDismissReportDraft() {
  return useTenantMutation<{ id: string; status: ReportDraftStatusValue }, Error, string>(
    async (draftId: string) => {
      const data = await graphqlClient.request<{
        dismissReportDraft: { id: string; status: ReportDraftStatusValue };
      }>(DISMISS_REPORT_DRAFT_MUTATION, { draftId });
      return data.dismissReportDraft;
    },
    { invalidate: [['reportDeadlines']] },
  );
}
