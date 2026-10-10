/**
 * How a REGULATORY DRAFT is presented — shared by the handheld and the board.
 *
 * Same reasoning as src/utils/unit-display.ts, one domain over: two screens
 * render the same Mattilsynet queue, and a deadline that reads "Due in 2d" on
 * the phone and "Due 2026-08-09" on the wall is two answers to one question. The
 * label table, the period string and the urgency wording are declared once here
 * so neither surface can drift.
 */
import type { ReportDeadline } from '@/hooks/useReportDeadlines';

/**
 * The human name for each `reportType`.
 *
 * The fallback at the callsite is the RAW ENUM, deliberately: an unmapped report
 * type is a contract the frontend has not caught up with, and showing
 * `CLEANER_FISH_V2` is honest about that, where a generic "Report" would hide it
 * from the manager AND from whoever reads the screenshot.
 */
const REPORT_TYPE_LABELS: Record<string, string> = {
  SEA_LICE: 'Sea Lice (weekly)',
  CLEANER_FISH: 'Cleaner Fish (monthly)',
  SMOLT: 'Smolt (monthly)',
  SLAUGHTER_PLANNED: 'Slaughter Planned',
  SLAUGHTER_EXECUTED: 'Slaughter Executed',
  BIOMASS: 'Biomass (Altinn)',
};

/** The report's name, or its raw type when the client does not know it yet. */
export function reportTypeLabel(row: ReportDeadline): string {
  return REPORT_TYPE_LABELS[row.reportType] ?? row.reportType;
}

/** Which period the filing covers: "2026 · W31", "2026-07", or the bare year. */
export function periodLabel(row: ReportDeadline): string {
  if (row.periodWeek != null) return `${row.periodYear} · W${row.periodWeek}`;
  if (row.periodMonth != null) {
    return `${row.periodYear}-${String(row.periodMonth).padStart(2, '0')}`;
  }
  return String(row.periodYear);
}

/** The tones a deadline can wear. `neutral` is "there is time". */
export type DeadlineTone = 'crit' | 'warn' | 'neutral';

export interface DeadlineLabel {
  text: string;
  tone: DeadlineTone;
}

/**
 * How urgent this filing is, in words and in tone.
 *
 * The tone always travels WITH text that says the same thing ("Overdue", "Due in
 * 2d"), so the urgency survives on a colourblind reader's screen and in a
 * greyscale screenshot — coral alone is not a deadline.
 */
export function dueLabel(row: ReportDeadline): DeadlineLabel {
  if (row.overdue) return { text: 'Overdue', tone: 'crit' };
  if (row.daysUntilDue != null && row.daysUntilDue <= 2) {
    return { text: `Due in ${row.daysUntilDue}d`, tone: 'warn' };
  }
  return { text: row.dueAt ? `Due ${row.dueAt}` : 'Unscheduled', tone: 'neutral' };
}
