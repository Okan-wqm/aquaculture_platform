/**
 * The sensor-reading tier policy — ONE place for every number that decides how
 * far back a reading can be asked for, which store answers it, at what
 * resolution, and how long each store keeps it.
 *
 * WHY here: the same facts were written by hand in the series query (365-day
 * cap, twice), the tier choice (1 h / 24 h / 720 h), the display-interval
 * ladder, the interval whitelist, the rollup SQL (refresh windows, 1-year and
 * 5-year retention), the manual-refresh horizons and the as-of lookback. Each
 * copy could drift on its own — and a retention change that reached the SQL
 * but not the tier choice would send charts to a store that no longer holds
 * the data. Zero dependencies, so the backend, the rollup DDL and (later) the
 * browser all read the same table.
 *
 * Values are `as const` tables, not enums: shared-contracts declares no enums
 * (tests/invariants/shared-contracts-no-enum-drift.spec.ts).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

/** A duration as both the PostgreSQL interval literal and milliseconds. */
export interface PolicyDuration {
  readonly sql: string;
  readonly ms: number;
}

/**
 * Every bucket width a series may be aggregated to — the time_bucket
 * whitelist. The GraphQL `AggregationInterval` enum's values must equal these
 * (checked at compile time where the enum is declared).
 */
export const AGGREGATION_INTERVALS = [
  { key: 'ONE_MINUTE', sql: '1 minute', ms: MINUTE_MS },
  { key: 'FIVE_MINUTES', sql: '5 minutes', ms: 5 * MINUTE_MS },
  { key: 'FIFTEEN_MINUTES', sql: '15 minutes', ms: 15 * MINUTE_MS },
  { key: 'ONE_HOUR', sql: '1 hour', ms: HOUR_MS },
  { key: 'FOUR_HOURS', sql: '4 hours', ms: 4 * HOUR_MS },
  { key: 'ONE_DAY', sql: '1 day', ms: DAY_MS },
  { key: 'ONE_WEEK', sql: '1 week', ms: 7 * DAY_MS },
] as const;

export type AggregationIntervalSql = (typeof AGGREGATION_INTERVALS)[number]['sql'];

/** The interval whitelist, in ascending width. */
export const AGGREGATION_INTERVAL_SQL: readonly AggregationIntervalSql[] =
  AGGREGATION_INTERVALS.map((interval) => interval.sql);

/** The longest window one series request may span. */
export const MAX_SERIES_RANGE_MS = YEAR_MS;

/**
 * How far back an as-of ("latest value") projection looks. A bound keeps the
 * read chunk-pruned and lets a long-dead channel drop out instead of having
 * its last value presented as current.
 */
export const AS_OF_LOOKBACK: PolicyDuration = { sql: '7 days', ms: 7 * DAY_MS };

interface DisplayRung {
  readonly maxWindowMs: number;
  readonly interval: AggregationIntervalSql;
}

/** The last rung: any longer window is shown weekly. */
const COARSEST_DISPLAY_RUNG: DisplayRung = {
  maxWindowMs: Number.POSITIVE_INFINITY,
  interval: '1 week',
};

/**
 * Display resolution by window length: the first rung whose window is at
 * least the requested one. Targets roughly 30–100 points per chart.
 */
export const DISPLAY_INTERVAL_LADDER: readonly DisplayRung[] = [
  { maxWindowMs: HOUR_MS, interval: '1 minute' },
  { maxWindowMs: 6 * HOUR_MS, interval: '5 minutes' },
  { maxWindowMs: DAY_MS, interval: '15 minutes' },
  { maxWindowMs: 3 * DAY_MS, interval: '1 hour' },
  { maxWindowMs: 7 * DAY_MS, interval: '4 hours' },
  { maxWindowMs: 30 * DAY_MS, interval: '1 day' },
  COARSEST_DISPLAY_RUNG,
];

/** The display interval for a window of `windowMs`. */
export function displayIntervalFor(windowMs: number): AggregationIntervalSql {
  // The ladder ends at an unbounded rung, so a rung always matches; the
  // fallback is that same rung, not a separate default.
  const rung =
    DISPLAY_INTERVAL_LADDER.find((candidate) => windowMs <= candidate.maxWindowMs) ??
    COARSEST_DISPLAY_RUNG;
  return rung.interval;
}

/**
 * The stores a series is read from, finest first. `bucket` is a rollup's
 * native resolution (null for raw rows). `maxWindowMs` is the
 * longest window the tier answers; `retention` is how long it keeps data
 * (null = kept indefinitely, or — for raw — governed by the archive ledger).
 * `refresh` is the continuous-aggregate policy that maintains a rollup.
 */
export const METRIC_TIERS = [
  {
    tier: 'raw',
    table: 'sensor_metrics',
    bucket: null,
    maxWindowMs: HOUR_MS,
    retention: null,
    refresh: null,
  },
  {
    tier: 'minute',
    table: 'metrics_1min',
    bucket: { sql: '1 minute', ms: MINUTE_MS },
    maxWindowMs: DAY_MS,
    retention: { sql: '1 year', ms: YEAR_MS },
    // Start offsets are one full step behind the schedule: edge gateways
    // buffer offline and replay telemetry hours to days late.
    refresh: {
      startOffset: { sql: '24 hours', ms: DAY_MS },
      endOffset: { sql: '1 minute', ms: MINUTE_MS },
      schedule: { sql: '1 minute', ms: MINUTE_MS },
    },
  },
  {
    tier: 'hour',
    table: 'metrics_1hour',
    bucket: { sql: '1 hour', ms: HOUR_MS },
    maxWindowMs: 30 * DAY_MS,
    retention: { sql: '5 years', ms: 5 * YEAR_MS },
    refresh: {
      startOffset: { sql: '7 days', ms: 7 * DAY_MS },
      endOffset: { sql: '1 hour', ms: HOUR_MS },
      schedule: { sql: '1 hour', ms: HOUR_MS },
    },
  },
  {
    tier: 'day',
    table: 'metrics_1day',
    bucket: { sql: '1 day', ms: DAY_MS },
    maxWindowMs: Number.POSITIVE_INFINITY,
    retention: null,
    refresh: {
      startOffset: { sql: '30 days', ms: 30 * DAY_MS },
      endOffset: { sql: '1 day', ms: DAY_MS },
      schedule: { sql: '1 day', ms: DAY_MS },
    },
  },
] as const;

export type MetricTierName = (typeof METRIC_TIERS)[number]['tier'];
export type MetricTier = (typeof METRIC_TIERS)[number];

/** The tier for one name — the table is the whole of the lookup. */
export function metricTier<N extends MetricTierName>(
  name: N,
): Extract<MetricTier, { readonly tier: N }> {
  const tier = METRIC_TIERS.find((candidate) => candidate.tier === name);
  if (tier === undefined) {
    throw new Error(`Unknown metric tier: ${name}`);
  }
  return tier as Extract<MetricTier, { readonly tier: N }>;
}

/** The finest tier that answers a window of `windowMs`. */
export function tierForWindow(windowMs: number): MetricTier {
  // The last tier answers an unbounded window, so a tier always matches; the
  // fallback names that tier rather than inventing a default.
  return METRIC_TIERS.find((candidate) => windowMs <= candidate.maxWindowMs) ?? metricTier('day');
}
