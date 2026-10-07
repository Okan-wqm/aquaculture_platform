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
 * The statement timeout a history read runs under: a year-long, many-channel
 * request must fail fast rather than hold a pooled connection.
 */
export const SERIES_QUERY_TIMEOUT: PolicyDuration = { sql: '5s', ms: 5_000 };

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

/** The most points one channel's series can carry under this policy. */
export const MAX_POINTS_PER_CHANNEL = 2_000;

/**
 * What a series' buckets must line up with: UTC, or a zone's local clock (the
 * site's day, owner decision 2026-10-06). `wholeHourOffset` says whether the
 * zone's offset is a whole number of hours (Oslo, Istanbul) or not (Kolkata
 * +05:30, Kathmandu +05:45) — hourly rows split cleanly at a local midnight
 * only in the first case.
 */
export type SeriesBucketZone =
  | { readonly kind: 'utc' }
  | { readonly kind: 'zoned'; readonly wholeHourOffset: boolean };

/** What a series read will actually do: the store, the bucket width and how buckets align. */
export interface SeriesReadPlan {
  readonly tier: MetricTier;
  readonly interval: AggregationIntervalSql;
  /**
   * `zone` when buckets start at the zone's local boundaries; `utc` when they
   * start at UTC ones — for a UTC zone, or when the window starts before the
   * finer stores' retention and only UTC-bucketed daily rows remain.
   */
  readonly alignment: 'zone' | 'utc';
  /**
   * Read the hourly rows plus, for each hour that straddles a local bucket
   * boundary, that hour's minute rows — exact for a zone whose offset is not
   * a whole hour.
   */
  readonly boundaryMinutes: boolean;
}

function intervalForMs(ms: number): (typeof AGGREGATION_INTERVALS)[number] {
  // The narrowest whitelisted width at least `ms` wide; the widest otherwise.
  return (
    AGGREGATION_INTERVALS.find((interval) => interval.ms >= ms) ??
    AGGREGATION_INTERVALS[AGGREGATION_INTERVALS.length - 1] ??
    AGGREGATION_INTERVALS[0]
  );
}

/**
 * Choose the store and bucket width for a series over [startMs, endMs] read
 * at `nowMs`, optionally at a requested width. One rule for every series
 * read, so the response can say truthfully what it returns:
 *
 * 1. Start from the finest store that answers a window this long.
 * 2. Move coarser while the store no longer retains data as old as the
 *    window's start — a one-hour chart from two years ago reads the hourly
 *    rollup, not an emptied minute tier.
 * 3. The width is the requested one (or the display ladder's for the
 *    window), but never finer than the store's native bucket: a store cannot
 *    be read finer than it keeps.
 * 4. A requested width at least as coarse as a coarser store's bucket reads
 *    that store instead — the same answer from fewer rows.
 * 5. Buckets in a zone other than UTC start at the zone's local boundaries,
 *    read from stores that can be split there (see below).
 */
export function planSeriesRead(params: {
  readonly startMs: number;
  readonly endMs: number;
  readonly nowMs: number;
  readonly requestedIntervalMs?: number;
  readonly zone?: SeriesBucketZone;
}): SeriesReadPlan {
  const windowMs = params.endMs - params.startMs;
  const baseIndex = METRIC_TIERS.indexOf(tierForWindow(windowMs));

  let tierIndex = baseIndex;
  for (; tierIndex < METRIC_TIERS.length - 1; tierIndex++) {
    const { retention } = METRIC_TIERS[tierIndex] ?? metricTier('day');
    if (retention === null || params.startMs >= params.nowMs - retention.ms) break;
  }

  const displayMs =
    AGGREGATION_INTERVALS.find((interval) => interval.sql === displayIntervalFor(windowMs))?.ms ??
    0;
  const wantedMs = params.requestedIntervalMs ?? displayMs;
  const floorMs = METRIC_TIERS[tierIndex]?.bucket?.ms ?? 0;
  const interval = intervalForMs(Math.max(wantedMs, floorMs));

  // Rule 4: the coarsest store whose own bucket still fits a width the
  // caller asked for. The default path keeps the window's store, so a chart
  // that asks for nothing reads exactly what it always read.
  if (params.requestedIntervalMs !== undefined) {
    for (let coarser = tierIndex + 1; coarser < METRIC_TIERS.length; coarser++) {
      const bucket = METRIC_TIERS[coarser]?.bucket;
      if (bucket && bucket.ms <= interval.ms) tierIndex = coarser;
    }
  }

  // Rule 5: local buckets. The daily rollup is bucketed in UTC, so a zoned
  // series reads the hourly rollup while it still holds the window's start;
  // in a zone whose offset is not a whole hour, the hours that straddle a
  // local boundary come from the minute rollup. Where neither finer store
  // reaches back far enough, the buckets stay UTC and the plan says so.
  const zone = params.zone ?? { kind: 'utc' };
  const retains = (name: MetricTierName): boolean => {
    const { retention } = metricTier(name);
    return retention === null || params.startMs >= params.nowMs - retention.ms;
  };
  let alignment: SeriesReadPlan['alignment'] = zone.kind === 'zoned' ? 'zone' : 'utc';
  let boundaryMinutes = false;
  if (zone.kind === 'zoned') {
    if (METRIC_TIERS[tierIndex]?.tier === 'day') {
      if (retains('hour')) {
        tierIndex = METRIC_TIERS.indexOf(metricTier('hour'));
      } else {
        alignment = 'utc';
      }
    }
    if (METRIC_TIERS[tierIndex]?.tier === 'hour' && !zone.wholeHourOffset) {
      if (retains('minute')) {
        boundaryMinutes = true;
      } else {
        alignment = 'utc';
      }
    }
  }

  return {
    tier: METRIC_TIERS[tierIndex] ?? metricTier('day'),
    interval: interval.sql,
    alignment,
    boundaryMinutes,
  };
}
