# Sensor series contract — honest store, width and gaps (2026-10-07)

Phase 2 of the sensor-history plan. It builds on the tier policy
(`libs/shared-contracts/src/sensor-readings/tier-policy.ts`, SENSOR-MEDIUM-149).

## SENSOR-HIGH-150 — store chosen by length alone; requested width reported

Before this change, store choice and reported width were decided separately:

- `selectMetricSource` chose the store by window length only.
- `channelSeries` and `aggregatedReadings` reported the requested width,
  chosen independently of the store.

Two consequences:

- A six-hour window from two years ago read `metrics_1min`, which keeps one
  year. The result was an empty chart while the hourly and daily rollups still
  held that day.
- An explicit width finer than the store's bucket was echoed back while the
  store's own bucket was returned.

Fix: one plan, `planSeriesRead` in the tier policy (`planMetricRead` in
`metric-source.ts`), decides the store and the width together:

1. Start from the window's store.
2. Move coarser while the store no longer keeps data as old as the window's
   start.
3. Never return a width finer than the store's bucket.
4. When the caller asked for a coarser width, read the coarser store that
   matches it.

Both series queries use the plan. The response reports `resolution`
(GraphQL `AggregationInterval`) and `sourceTier` (new `MetricSourceTier`;
compile-time checked against the policy), plus `bucketTimeZone` (UTC) and
`maxRangeSeconds`. `interval` stays and is deprecated.

The policy spec pins:

- Recent windows read exactly as before.
- The point count stays within 2 000 per channel for every window and width.

The scan is now [start − one source bucket, end): a rollup bucket that
overlaps the start counts, and a bucket starting at the end does not.

## SENSOR-HIGH-151 — disabled channels vanish; gaps unreported

Before this change:

- `getSeries` read enabled channels only. A probe switched off after an
  incident took its record with it, and a test pinned that.
- The response carried points only, so charts joined the samples on either
  side of missing data with a line.

Fix:

- Every channel's history is returned, with `enabled`, `displayLabel`,
  `unit`, `unitSymbol` and `precision`.
- `gaps` lists the stretches at least one bucket wide that hold no sample. They
  are read off the buckets the database aligned, so no alignment is
  recomputed in TypeScript.
- Each point carries `badCount`: the samples below GOOD quality, which are
  still counted in avg/min/max.
- A new `channelDataBounds(sensorIds)` query gives each channel's first and
  last stored sample, for a "jump to the data" control on an empty range:
  - first sample: the daily rollup, which is kept indefinitely;
  - last sample: the freshness-bounded raw lookup;
  - neither part scans raw history.
- History reads run under a statement timeout taken from the policy.

Proof: `channel-reading-query.rls.postgres.spec.ts` covers the contract fields,
the disabled channel, the gaps, the bounds, and that one tenant cannot read
another's bounds, all under FORCE RLS.

## SENSOR-HIGH-162 — series from a rollup were not re-bucketed

The rollups (`metrics_1min`, `metrics_1hour`, `metrics_1day`) have their own
`bucket` column. In `GROUP BY s.channel_id, bucket`, Postgres binds an
ambiguous name to the input column, not the output alias. The series query
therefore grouped by the rollup's own buckets and returned every minute (or
hour) as a separate point, stamped with the wider bucket's start: six hours
at 15 minutes came back as 360 points instead of 24. `/sensor/readings`
draws every view wider than the store's bucket this way, and so does main.

The existing series spec reads the raw hypertable, whose time column is
`time`, so the alias was unambiguous there and it never saw this.

Fix: both series queries group and order by position. `aggregatedReadings`
had the same grouping; its pivot merges same-bucket rows, so only its row
count was wrong.

Proof: `series-rebucketing.postgres.spec.ts` builds the production rollup
DDL on real TimescaleDB, seeds a sample a minute for three days, and asserts
one point per 15-minute bucket from the minute rollup and per 4-hour bucket
from the hourly rollup. With the old grouping it fails (360 points instead
of 24).
