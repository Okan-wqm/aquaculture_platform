/**
 * Metric-source selection shared by every sensor_metrics read model.
 *
 * Extracted from SensorQueryService so the nine-parameter reading projection
 * and the channel-generic reads (ChannelReadingQueryService) pick the same
 * tier for the same range, apply the same freshness bound and re-bucket
 * rollups the same way — one rule, not two copies that drift.
 */

import {
  AGGREGATION_INTERVALS,
  type AggregationIntervalSql,
  AS_OF_LOOKBACK as AS_OF_LOOKBACK_POLICY,
  metricTier,
  type MetricTierName,
  planSeriesRead,
  type SeriesBucketZone,
  type SeriesReadPlan,
} from '@aquaculture/shared-contracts';
import { Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import { QualityCodes } from '../../database/entities/sensor-metric.entity';

/**
 * How far back an as-of projection looks for a channel's last-known value.
 *
 * Every as-of query MUST carry a lower bound on `time`. Two independent reasons,
 * both found by the SENSOR-HIGH-085 pre-merge audit:
 *
 *  1. PERFORMANCE. Without a `time` predicate TimescaleDB cannot prune a single
 *     chunk, so a "give me the latest value" read degrades into a scan of the
 *     sensor's entire retention window — on a hot path the dashboard and
 *     aquamobil re-issue every 45 s.
 *  2. HONESTY. Forward-filling with no lower bound resurrects channels that
 *     stopped reporting long ago and presents their last value as part of a
 *     current reading. A bound means a dead channel drops out of the projection
 *     instead of being fabricated into it forever.
 *
 * The window is deliberately generous rather than tight: it must not truncate a
 * legitimately slow sensor (daily-sampled water chemistry), only unbounded scans
 * and long-dead channels. It is one constant used by all four projections, so
 * the freshness contract cannot drift between them.
 */
export const AS_OF_LOOKBACK = AS_OF_LOOKBACK_POLICY.sql;

/** Parse a pg driver value (numeric columns arrive as strings, counts as numbers). */
export function toNumberOrUndefined(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * A channel-keyed metric source for an aggregated read. `weighted` sources are
 * continuous aggregates that already store per-bucket partials, so re-bucketing
 * them to the display interval must weight each partial by its sample_count;
 * the raw hypertable aggregates plain values.
 */
export interface MetricSource {
  table: string;
  timeColumn: string;
  weighted: boolean;
}

// Fixed source whitelist — table names are literals, never user input, so they
// are safe to interpolate into the aggregation SQL. They are UNQUALIFIED so the
// tenant search_path resolves them inside the reading tenant's own schema: both
// the hypertable and its rollups are per-tenant.
// The table names come from the tier policy (the one owner of which store
// holds which resolution); the column shape is this read model's.
export const RAW_METRIC_SOURCE: MetricSource = {
  table: metricTier('raw').table,
  timeColumn: 'time',
  weighted: false,
};
export const METRIC_ROLLUP_SOURCES: Readonly<Record<Exclude<MetricTierName, 'raw'>, MetricSource>> =
  {
    minute: { table: metricTier('minute').table, timeColumn: 'bucket', weighted: true },
    hour: { table: metricTier('hour').table, timeColumn: 'bucket', weighted: true },
    day: { table: metricTier('day').table, timeColumn: 'bucket', weighted: true },
  };

/** What one series read does: the store, the bucket width it returns, the window, the alignment. */
export interface MetricReadPlan {
  readonly source: MetricSource;
  readonly interval: AggregationIntervalSql;
  readonly windowStart: Date;
  /** Buckets start at the series zone's local boundaries (`zone`) or UTC ones. */
  readonly alignment: SeriesReadPlan['alignment'];
  /** Hourly rows plus the minute rows of hours that straddle a local boundary. */
  readonly boundaryMinutes: boolean;
}

/** Native bucket width (ms) of each rollup source; raw rows have none. */
const SOURCE_BUCKET_MS = new Map<MetricSource, number>([
  [METRIC_ROLLUP_SOURCES.minute, metricTier('minute').bucket.ms],
  [METRIC_ROLLUP_SOURCES.hour, metricTier('hour').bucket.ms],
  [METRIC_ROLLUP_SOURCES.day, metricTier('day').bucket.ms],
]);

/** The tier a resolved source belongs to — what a response reports as its store. */
export function tierOfSource(source: MetricSource): MetricTierName {
  if (source === METRIC_ROLLUP_SOURCES.minute) return 'minute';
  if (source === METRIC_ROLLUP_SOURCES.hour) return 'hour';
  if (source === METRIC_ROLLUP_SOURCES.day) return 'day';
  return 'raw';
}

/**
 * Lower bound on `source`'s time column for a plan: a rollup bucket that
 * starts before the window but overlaps it still carries the window's first
 * rows. Taken from the source actually read — resolveExistingSource may have
 * fallen back to raw rows, which need no widening.
 */
export function scanStart(plan: MetricReadPlan, source: MetricSource): Date {
  const bucketMs = SOURCE_BUCKET_MS.get(source) ?? 0;
  return bucketMs === 0 ? plan.windowStart : new Date(plan.windowStart.getTime() - bucketMs + 1);
}

/**
 * Plan a series read through the tier policy (planSeriesRead) — the one rule
 * every series query follows, so the store, the width it reports and the
 * window it scans can never disagree. The width is never finer than the
 * store's bucket, and a window older than a store's retention reads a
 * coarser store.
 */
export function planMetricRead(
  startTime: Date,
  endTime: Date,
  requestedInterval?: AggregationIntervalSql,
  now: Date = new Date(),
  zone: SeriesBucketZone = { kind: 'utc' },
): MetricReadPlan {
  const requestedIntervalMs = AGGREGATION_INTERVALS.find(
    (interval) => interval.sql === requestedInterval,
  )?.ms;
  const plan = planSeriesRead({
    startMs: startTime.getTime(),
    endMs: endTime.getTime(),
    nowMs: now.getTime(),
    zone,
    ...(requestedIntervalMs === undefined ? {} : { requestedIntervalMs }),
  });
  const { tier } = plan.tier;
  return {
    source: tier === 'raw' ? RAW_METRIC_SOURCE : METRIC_ROLLUP_SOURCES[tier],
    interval: plan.interval,
    windowStart: startTime,
    alignment: plan.alignment,
    boundaryMinutes: plan.boundaryMinutes,
  };
}

/**
 * The bucket start and end expressions over a time expression, for the
 * plan's alignment. `refs` name the caller's bound parameters (the interval,
 * and the zone for local buckets). A local bucket's end comes from
 * `date_add` in the zone, so a 23- or 25-hour day ends where it really ends.
 * UTC buckets keep the zone-free `time_bucket`, exactly as before.
 */
export function seriesBucketExpressions(
  alignment: MetricReadPlan['alignment'],
  time: string,
  refs: { readonly interval: string; readonly zone: string },
): { bucket: string; bucketEnd: (bucket: string) => string } {
  if (alignment === 'utc') {
    return {
      bucket: `time_bucket(${refs.interval}::interval, ${time})`,
      bucketEnd: (bucket) => `${bucket} + ${refs.interval}::interval`,
    };
  }
  return {
    bucket: `time_bucket(${refs.interval}::interval, ${time}, ${refs.zone})`,
    bucketEnd: (bucket) => `date_add(${bucket}, ${refs.interval}::interval, ${refs.zone})`,
  };
}

/**
 * Resolve the tier to a source that ACTUALLY EXISTS in the reading tenant's
 * schema, degrading to the raw hypertable when the rollup is absent.
 *
 * The rollups are created by a bootstrap sweep (ContinuousAggregateService),
 * which cannot be a migration because continuous-aggregate DDL is illegal inside
 * a transaction. A tenant provisioned between boots therefore has its hypertable
 * but not yet its rollups. Without this probe such a tenant's charts would
 * resolve the view name through the search_path fallback and come back EMPTY —
 * a correct-looking, silent lie. Falling back to raw gives that tenant correct
 * (merely unoptimized) data and logs the degradation instead of hiding it.
 */
export async function resolveExistingSource(
  qr: QueryRunner,
  preferred: MetricSource,
  logger: Logger,
): Promise<MetricSource> {
  if (preferred === RAW_METRIC_SOURCE) {
    return preferred;
  }
  const rows = (await qr.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
    preferred.table,
  ])) as Array<{ present: boolean }>;
  if (rows[0]?.present === true) {
    return preferred;
  }
  logger.warn(
    `Rollup ${preferred.table} is not present in this tenant's schema — ` +
      'falling back to the raw hypertable for this read (charts stay correct, just unoptimized)',
  );
  return RAW_METRIC_SOURCE;
}

/**
 * The re-bucketing aggregate expressions for a source, over alias `s`. A rollup
 * stores per-bucket partials, so its average is weighted by sample_count; the
 * raw hypertable aggregates plain values.
 */
export function bucketAggregateExpressions(source: MetricSource): {
  avg: string;
  min: string;
  max: string;
  count: string;
  badCount: string;
} {
  return source.weighted
    ? {
        avg: 'SUM(s.avg_value * s.sample_count) / NULLIF(SUM(s.sample_count), 0)',
        min: 'MIN(s.min_value)',
        max: 'MAX(s.max_value)',
        count: 'SUM(s.sample_count)',
        badCount: 'SUM(s.bad_count)',
      }
    : {
        avg: 'AVG(s.value)',
        min: 'MIN(s.value)',
        max: 'MAX(s.value)',
        count: 'COUNT(*)',
        // Below GOOD is "bad" — the same split the rollups store as bad_count.
        badCount: `COUNT(*) FILTER (WHERE s.quality_code < ${QualityCodes.GOOD})`,
      };
}
