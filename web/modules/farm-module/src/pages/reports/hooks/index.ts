/**
 * Report Hooks Index
 * Exports all report-related hooks
 */

// useReportDraft (localStorage draft) was deleted as dead code: no tab ever
// consumed it — the server-assembled draft (reportDrafts / reportPrefill,
// Phase 3) is the SSoT, so a second localStorage draft concept was a duplicate
// carrying false test coverage. A crash-recovery buffer, if wanted later, is
// built against the server draftId, not resurrected here.
// useDeadlines was deleted under FARM-HIGH-125: it had no consumer and
// synthesized deadline state from the mock report arrays. Deadline
// awareness now derives from the persisted-submission summary in
// ReportsPage (useRegulatoryReportSummary + utils/thresholds calendar).
export { useThresholdCheck } from './useThresholdCheck';
export type { ThresholdSeverity, ThresholdCheckResult, MortalityThresholdInput, SeaLiceThresholdInput, UseThresholdCheckReturn } from './useThresholdCheck';
