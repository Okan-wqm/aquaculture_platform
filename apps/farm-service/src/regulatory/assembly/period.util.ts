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

/**
 * FARM-HIGH-005 — is the live standing stock too stale to stand in for a
 * period's closing beholdning?
 *
 * The biomass calculator reports the CURRENT live inventory. That is a faithful
 * proxy for a month's closing stock only while the period is recent: a biomass
 * report is filed by the 7th of the month AFTER its period, so at filing time
 * the period end is normally in the immediately-preceding month and only a few
 * days of post-period movement have accrued. Once a FULL extra month has
 * elapsed — the report is for a month before last — post-period mortality,
 * growth, harvest, and transfers have moved the live stock materially away from
 * that historical month-end, so the number can no longer be claimed as RECORDS.
 *
 * Fresh iff the period end falls in the current month or the immediately
 * preceding month relative to `now` (UTC, calendar-based so it is DST-safe).
 * The deeper fix — a point-in-time stock ledger that reconstructs the exact
 * month-end beholdning — is tracked separately; until it exists, a stale
 * period fails closed to MANUAL_REQUIRED rather than filing a false RECORDS
 * number.
 */
export function isStandingStockStale(periodEndIso: string, now: Date): boolean {
  const periodEnd = new Date(`${periodEndIso}T00:00:00.000Z`);
  const freshFloor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return periodEnd.getTime() < freshFloor;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** ISO-8601 year + week of a calendar date (Thursday-anchored). */
export function isoWeekOf(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}
