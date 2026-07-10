/**
 * Scheduled report-draft GraphQL operations (RPT-003).
 *
 * The scheduler assembles a draft per (site, report type, period) each cycle;
 * these back the operator Reports-due view — the deadline list + the draft
 * lifecycle actions (refresh, approve & submit, dismiss). Maps to the backend
 * RegulatoryReportDraftResolver.
 *
 * @module FarmModule/GraphQL
 */

export const REPORT_DEADLINES_QUERY = `
  query ReportDeadlines {
    reportDeadlines {
      id
      reportType
      siteId
      periodYear
      periodWeek
      periodMonth
      status
      dueAt
      overdue
      daysUntilDue
    }
  }
`;

export const REPORT_DRAFTS_QUERY = `
  query ReportDrafts($filter: ReportDraftFilterInput) {
    reportDrafts(filter: $filter) {
      id
      reportType
      siteId
      periodYear
      periodWeek
      periodMonth
      status
      schemaValid
      dueAt
      assembledPayload
      fieldMeta
      manualOverrides
    }
  }
`;

export const SAVE_REPORT_DRAFT_OVERRIDES_MUTATION = `
  mutation SaveReportDraftOverrides($input: SaveReportDraftOverridesInput!) {
    saveReportDraftOverrides(input: $input) {
      id
      status
      schemaValid
      manualOverrides
    }
  }
`;

export const REFRESH_REPORT_DRAFT_MUTATION = `
  mutation RefreshReportDraft($draftId: ID!) {
    refreshReportDraft(draftId: $draftId) {
      id
      status
      schemaValid
      dueAt
    }
  }
`;

export const DISMISS_REPORT_DRAFT_MUTATION = `
  mutation DismissReportDraft($draftId: ID!) {
    dismissReportDraft(draftId: $draftId) {
      id
      status
    }
  }
`;

export const APPROVE_AND_SUBMIT_REPORT_DRAFT_MUTATION = `
  mutation ApproveAndSubmitReportDraft($draftId: ID!) {
    approveAndSubmitReportDraft(draftId: $draftId) {
      success
      reportId
      referanse
      klientReferanse
      feilmelding
      valideringsfeil {
        felt
        melding
      }
    }
  }
`;
