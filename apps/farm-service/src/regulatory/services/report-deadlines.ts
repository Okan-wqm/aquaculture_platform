/**
 * Regulatory report deadline engine (RPT-003/018) — the ONE place the official
 * Mattilsynet submission deadlines are encoded, so the scheduler, the deadline
 * sweep, and the frontend indicator all agree.
 *
 * Deadlines are DATE-granular in Oslo wall-clock ("innen 7. i måneden",
 * "tirsdag i påfølgende uke") — the regulator expresses them as calendar days,
 * not instants — so `computeDueDate` returns a `yyyy-mm-dd` string and the
 * sweep compares it against the current Oslo date (`osloDateString`). This
 * avoids DST-instant conversion entirely: a calendar date has no timezone, and
 * the only timezone touch point is "which Oslo day is it now".
 */
import { ReportPrefillPeriod, ReportPrefillType } from '../assembly/report-assembly.service';
import { isoWeekRange } from '../assembly/period.util';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Add `days` to a `yyyy-mm-dd` date, returning `yyyy-mm-dd` (UTC calendar math). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The 7th of the month following (year, month) — the monthly-report deadline. */
function seventhOfFollowingMonth(year: number, month: number): string {
  let y = year;
  let m = month + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${y}-${pad2(m)}-07`;
}

function requireWeek(reportType: ReportPrefillType, period: ReportPrefillPeriod): number {
  if (!period.week) {
    throw new Error(`${reportType} deadline requires periodWeek (ISO 1-53).`);
  }
  return period.week;
}

function requireMonth(reportType: ReportPrefillType, period: ReportPrefillPeriod): number {
  if (!period.month) {
    throw new Error(`${reportType} deadline requires periodMonth (1-12).`);
  }
  return period.month;
}

/**
 * The official submission deadline for a scheduled report, as an Oslo
 * wall-clock calendar date (`yyyy-mm-dd`). Throws for the varsling types
 * (welfare/escape/disease) — those are legally IMMEDIATE and event-triggered,
 * never scheduled, so asking for their scheduled deadline is a programming
 * error, not a missing value.
 */
export function computeDueDate(reportType: ReportPrefillType, period: ReportPrefillPeriod): string {
  switch (reportType) {
    // Weekly sea-lice: Tuesday of the following week (week ends Sunday → +2 days).
    case ReportPrefillType.SEA_LICE: {
      const { toDate } = isoWeekRange(period.year, requireWeek(reportType, period));
      return addDays(toDate, 2);
    }
    // Planned slaughter: Thursday of the week BEFORE the slaughter week
    // (slaughter week Monday − 4 days = previous Thursday).
    case ReportPrefillType.SLAUGHTER_PLANNED: {
      const { fromDate } = isoWeekRange(period.year, requireWeek(reportType, period));
      return addDays(fromDate, -4);
    }
    // Executed slaughter: reported per week, all due by the 7th of the month
    // following the one the week belongs to (ISO week belongs to its Thursday).
    case ReportPrefillType.SLAUGHTER_EXECUTED: {
      const { fromDate } = isoWeekRange(period.year, requireWeek(reportType, period));
      const thursday = new Date(`${addDays(fromDate, 3)}T00:00:00Z`);
      return seventhOfFollowingMonth(thursday.getUTCFullYear(), thursday.getUTCMonth() + 1);
    }
    // Monthly reports: by the 7th of the following month.
    case ReportPrefillType.SMOLT:
    case ReportPrefillType.CLEANER_FISH:
    case ReportPrefillType.BIOMASS:
      return seventhOfFollowingMonth(period.year, requireMonth(reportType, period));
    default:
      throw new Error(
        `${reportType} has no scheduled deadline — welfare/escape/disease varsling are ` +
          'legally immediate and event-triggered, not scheduled reports.',
      );
  }
}

/**
 * The current calendar date in Europe/Oslo (`yyyy-mm-dd`) for the given
 * instant. Pure given `now`, so the sweep is testable with a fixed clock.
 * `Intl` with an explicit timeZone is the single DST-correct touch point.
 */
export function osloDateString(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // en-CA formats as yyyy-mm-dd.
  return parts;
}

/** True when `dueDate` (yyyy-mm-dd) is today-or-earlier in Oslo. */
export function isOverdueInOslo(dueDate: string, now: Date): boolean {
  return dueDate <= osloDateString(now);
}

/**
 * Whole Oslo-calendar days from today until `dueDate` (yyyy-mm-dd): 0 = due
 * today, positive = future, negative = overdue. Both endpoints are compared as
 * calendar dates (UTC midnight of each yyyy-mm-dd) so DST never shifts the
 * count — the Oslo calendar date is resolved once via osloDateString.
 */
export function osloDaysUntil(dueDate: string, now: Date): number {
  const todayMs = Date.parse(`${osloDateString(now)}T00:00:00Z`);
  const dueMs = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.round((dueMs - todayMs) / 86_400_000);
}

/** Deadline-reminder buckets, one outbox notification per transition. */
export const DEADLINE_BUCKETS = ['APPROACHING', 'DUE_SOON', 'DUE', 'OVERDUE'] as const;
export type DeadlineBucket = (typeof DEADLINE_BUCKETS)[number];

/**
 * Which reminder bucket a draft sits in for `now`, or null when its deadline is
 * more than three Oslo-calendar days away (not yet worth a reminder). The daily
 * sweep raises one event per bucket TRANSITION: APPROACHING (2–3 days out) →
 * DUE_SOON (1 day) → DUE (today) → OVERDUE (past).
 */
export function deadlineBucket(dueDate: string, now: Date): DeadlineBucket | null {
  const days = osloDaysUntil(dueDate, now);
  if (days < 0) return 'OVERDUE';
  if (days === 0) return 'DUE';
  if (days === 1) return 'DUE_SOON';
  if (days <= 3) return 'APPROACHING';
  return null;
}
