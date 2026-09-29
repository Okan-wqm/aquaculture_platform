/**
 * Pure helpers for the mortality alert evaluation (FARM-HIGH-334).
 *
 * WHY a separate module: the listener used to compute "today" as the SERVER's
 * midnight and filter the `date` column with `MoreThan(midnight)` — a `date`
 * equal to today compares as today 00:00, which is NOT greater than midnight,
 * so today's deaths were never counted and the daily-rate alarm could not fire.
 * The day arithmetic now works on calendar-day strings (`YYYY-MM-DD`), the
 * exact representation the column stores, so no timestamp ever meets a date.
 */

/** Days of history in the trend window, the event's own day included. */
export const MORTALITY_TREND_WINDOW_DAYS = 7;

/** The later part of the window compared against the earlier one for the trend. */
const RECENT_PART_DAYS = 4;

/** Shift a `YYYY-MM-DD` calendar day by whole days (calendar arithmetic, no zone). */
export function shiftCalendarDay(day: string, deltaDays: number): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    throw new TypeError(`shiftCalendarDay: "${day}" is not a YYYY-MM-DD day`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, date + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

export interface DailyMortalityRow {
  /** `YYYY-MM-DD` */
  day: string;
  count: number;
}

export interface MortalityWindowSummary {
  /** Deaths recorded under the event's own day. */
  dayCount: number;
  weeklyAverage: number;
  trend: 'increasing' | 'stable' | 'decreasing';
}

/**
 * Summarise per-day counts of the trend window ending at `day`. The recent
 * part is the last four days (the event's day included), compared with the
 * three before it, as the listener always did.
 */
export function summarizeMortalityWindow(
  rows: DailyMortalityRow[],
  day: string,
): MortalityWindowSummary {
  const recentFrom = shiftCalendarDay(day, -(RECENT_PART_DAYS - 1));
  let dayCount = 0;
  let total = 0;
  let recent = 0;
  let earlier = 0;
  for (const row of rows) {
    total += row.count;
    if (row.day === day) dayCount += row.count;
    // `YYYY-MM-DD` strings order chronologically.
    if (row.day >= recentFrom) recent += row.count;
    else earlier += row.count;
  }

  let trend: MortalityWindowSummary['trend'] = 'stable';
  if (recent > earlier * 1.5) trend = 'increasing';
  else if (recent < earlier * 0.5) trend = 'decreasing';

  return { dayCount, weeklyAverage: total / MORTALITY_TREND_WINDOW_DAYS, trend };
}

export interface CumulativeThresholds {
  warning: number;
  critical: number;
}

/**
 * The cumulative-rate level this ONE record crossed, or null.
 *
 * WHY edge-triggered (FARM-HIGH-334): the cumulative rate only grows, so the
 * old level check fired again on every later mortality record once 5% was
 * passed — for the rest of the cycle, where 5–10% is normal late mortality.
 * The rate before this record is exact because the denominator (initial
 * quantity) is fixed: `rate · (total − quantity) / total`.
 */
export function cumulativeRateCrossing(
  input: { newMortalityRate: number; newTotalMortality: number; quantity: number },
  thresholds: CumulativeThresholds,
): 'warning' | 'critical' | null {
  const { newMortalityRate, newTotalMortality, quantity } = input;
  const previousRate =
    newTotalMortality > 0
      ? (newMortalityRate * (newTotalMortality - quantity)) / newTotalMortality
      : 0;
  const crossed = (threshold: number): boolean =>
    previousRate < threshold && newMortalityRate >= threshold;
  if (crossed(thresholds.critical)) return 'critical';
  if (crossed(thresholds.warning)) return 'warning';
  return null;
}
