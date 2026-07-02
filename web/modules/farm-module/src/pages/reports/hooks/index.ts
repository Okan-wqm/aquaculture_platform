/**
 * Report Hooks Index
 * Exports all report-related hooks
 */

export { useReportDraft } from './useReportDraft';
// useDeadlines was deleted under FARM-HIGH-125: it had no consumer and
// synthesized deadline state from the mock report arrays. Deadline
// awareness now derives from the persisted-submission summary in
// ReportsPage (useRegulatoryReportSummary + utils/thresholds calendar).
export { useThresholdCheck } from './useThresholdCheck';
export type { ThresholdSeverity, ThresholdCheckResult, MortalityThresholdInput, SeaLiceThresholdInput, UseThresholdCheckReturn } from './useThresholdCheck';
