/**
 * Shared reporting-period helpers for the assemblers (one implementation —
 * month and ISO-week math must never fork per report type).
 */

export interface PeriodRange {
  /** Inclusive ISO date (yyyy-mm-dd). */
  fromDate: string;
  /** Inclusive ISO date (yyyy-mm-dd). */
  toDate: string;
}

export function monthRange(year: number, month: number): PeriodRange {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return {
    fromDate: `${year}-${mm}-01`,
    toDate: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

/**
 * Monday..Sunday range of an ISO-8601 week. January 4th is always in ISO
 * week 1, which anchors the calendar without a library.
 */
export function isoWeekRange(isoYear: number, isoWeek: number): PeriodRange {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7; // Mon=1 … Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Weekday - 1));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { fromDate: toIsoDate(monday), toDate: toIsoDate(sunday) };
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
