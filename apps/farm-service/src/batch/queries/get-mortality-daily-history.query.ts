/**
 * Daily mortality history (all sites) for the health page chart.
 *
 * Single-purpose per-day totals over `mortality_records` — unlike
 * GetMortalityByCauseQuery (the regulatory by-cause SSoT), this carries no
 * species/batch joins so a record with a dangling batch reference is still
 * counted. Days with zero mortality are absent from the result; callers
 * zero-fill the gap for display.
 */
import { IQuery } from '@platform/cqrs';

export interface MortalityDailyPoint {
  /** ISO date (yyyy-mm-dd) of the mortality records. */
  date: string;
  count: number;
}

export class GetMortalityDailyHistoryQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    /** How many days back (inclusive of today). */
    public readonly days: number,
  ) {}
}
