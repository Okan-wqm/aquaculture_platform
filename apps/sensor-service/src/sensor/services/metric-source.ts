/**
 * Metric-source selection shared by every sensor_metrics read model.
 *
 * Extracted from SensorQueryService so the nine-parameter reading projection
 * and the channel-generic reads (ChannelReadingQueryService) pick the same
 * tier for the same range, apply the same freshness bound and re-bucket
 * rollups the same way — one rule, not two copies that drift.
 */

import {
  AS_OF_LOOKBACK as AS_OF_LOOKBACK_POLICY,
  metricTier,
  type MetricTierName,
  tierForWindow,
} from '@aquaculture/shared-contracts';
import { Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

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

/**
 * Pick the metric source by range so a month-long chart reads a pre-rolled
 * continuous aggregate instead of scanning raw rows. The auto-selected display interval (getOptimalInterval)
 * is always ≥ the chosen source's native bucket, so re-bucketing never asks a
 * rollup for finer granularity than it stores.
 */
export function selectMetricSource(startTime: Date, endTime: Date): MetricSource {
  const { tier } = tierForWindow(endTime.getTime() - startTime.getTime());
  return tier === 'raw' ? RAW_METRIC_SOURCE : METRIC_ROLLUP_SOURCES[tier];
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
} {
  return source.weighted
    ? {
        avg: 'SUM(s.avg_value * s.sample_count) / NULLIF(SUM(s.sample_count), 0)',
        min: 'MIN(s.min_value)',
        max: 'MAX(s.max_value)',
        count: 'SUM(s.sample_count)',
      }
    : { avg: 'AVG(s.value)', min: 'MIN(s.value)', max: 'MAX(s.value)', count: 'COUNT(*)' };
}
