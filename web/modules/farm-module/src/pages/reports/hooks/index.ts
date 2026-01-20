/**
 * Report Hooks Index
 * Exports all report-related hooks
 */

export { useReportDraft, getAllDraftKeys, clearAllDrafts } from './useReportDraft';
export { useDeadlines, getUrgencyColorClasses, getUrgencyLabel } from './useDeadlines';
export type { DeadlineUrgency, DeadlineInfo, UpcomingDeadline, UseDeadlinesOptions, UseDeadlinesReturn } from './useDeadlines';
export { useThresholdCheck } from './useThresholdCheck';
export type { ThresholdSeverity, ThresholdCheckResult, MortalityThresholdInput, SeaLiceThresholdInput, UseThresholdCheckReturn } from './useThresholdCheck';
