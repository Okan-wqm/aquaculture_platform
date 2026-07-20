/**
 * Sensor Query Service
 * Provides optimized time-series queries using TimescaleDB features
 *
 * Security:
 * - SQL injection protection with parameterized queries
 * - Aggregation interval whitelist validation
 * - Input validation for all parameters
 *
 * Performance:
 * - TimescaleDB time_bucket for efficient aggregation
 * - Automatic interval selection based on time range
 * - Query result caching consideration
 */

import { runInTenantRead } from '@aquaculture/backend-common/database';
import { encodeSensorReadingId } from '@aquaculture/backend-common/sensor';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { parameterForChannelKey, type SensorReadingParameter } from '@platform/event-contracts';
import { DataSource, QueryRunner } from 'typeorm';

import { SensorReading, SensorReadings } from '../../database/entities/sensor-reading.entity';
import {
  AggregatedReadingType,
  AggregatedReadingsResponse,
} from '../dto/aggregated-reading.dto';
import { DataQualityService } from './data-quality.service';
import {
  validateSensorId,
  validateTenantId,
  validateAggregationInterval,
  validateDateRange,
  validateLimit,
  ALLOWED_AGGREGATION_INTERVALS,
  SafeAggregationInterval,
} from '../validation/input-sanitizer';

/** The `sensor` source schema runInTenantRead pins alongside the tenant schema. */
const SENSOR_SCHEMA = 'sensor';

/**
 * Aggregation interval type - restricted to whitelist
 */
export type AggregationInterval = SafeAggregationInterval;

/**
 * Maximum allowed query time range (365 days)
 */
const MAX_QUERY_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Maximum results limit
 */
const MAX_RESULTS_LIMIT = 10000;

/**
 * Default results limit
 */
const DEFAULT_RESULTS_LIMIT = 1000;

/**
 * Determine optimal aggregation interval based on time range
 * Target: 50-200 data points for optimal visualization
 */
export function getOptimalInterval(startTime: Date, endTime: Date): AggregationInterval {
  const durationMs = endTime.getTime() - startTime.getTime();
  const hours = durationMs / (1000 * 60 * 60);

  if (hours <= 1) return '1 minute'; // 60 points max
  if (hours <= 6) return '5 minutes'; // 72 points max
  if (hours <= 24) return '15 minutes'; // 96 points max
  if (hours <= 72) return '1 hour'; // 72 points max
  if (hours <= 168) return '4 hours'; // 42 points max
  if (hours <= 720) return '1 day'; // 30 points max
  return '1 week'; // 52 points max for year
}

/** Parse a pg driver value (numeric columns arrive as strings, counts as numbers). */
function toNumberOrUndefined(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const num = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * The five parameters the AggregatedReading DTO carries min/max for; the rest
 * are avg-only. Kept aligned with aggregated-reading.dto.ts.
 */
const MIN_MAX_PARAMETERS: ReadonlySet<SensorReadingParameter> = new Set([
  'temperature',
  'ph',
  'dissolvedOxygen',
  'salinity',
  'ammonia',
]);

/**
 * A channel-keyed metric source for an aggregated read. `weighted` sources are
 * continuous aggregates that already store per-bucket partials, so re-bucketing
 * them to the display interval must weight each partial by its sample_count;
 * the raw hypertable aggregates plain values.
 */
interface MetricSource {
  table: string;
  timeColumn: string;
  weighted: boolean;
}

// Fixed source whitelist — table names are literals, never user input, so they
// are safe to interpolate into the aggregation SQL.
const RAW_METRIC_SOURCE: MetricSource = {
  table: 'sensor.sensor_metrics',
  timeColumn: 'time',
  weighted: false,
};
const METRIC_ROLLUP_SOURCES: Readonly<Record<'minute' | 'hour' | 'day', MetricSource>> = {
  minute: { table: 'sensor.metrics_1min', timeColumn: 'bucket', weighted: true },
  hour: { table: 'sensor.metrics_1hour', timeColumn: 'bucket', weighted: true },
  day: { table: 'sensor.metrics_1day', timeColumn: 'bucket', weighted: true },
};

/**
 * Pick the metric source by range so a month-long chart reads a pre-rolled
 * continuous aggregate instead of scanning raw rows — the same tier thresholds
 * MetricQueryService uses. The auto-selected display interval (getOptimalInterval)
 * is always ≥ the chosen source's native bucket, so re-bucketing never asks a
 * rollup for finer granularity than it stores.
 */
function selectMetricSource(startTime: Date, endTime: Date): MetricSource {
  const hours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
  if (hours <= 1) return RAW_METRIC_SOURCE;
  if (hours <= 24) return METRIC_ROLLUP_SOURCES.minute;
  if (hours <= 720) return METRIC_ROLLUP_SOURCES.hour;
  return METRIC_ROLLUP_SOURCES.day;
}

/** Assign a finite numeric value onto a dynamically-named aggregate field bag. */
function setAggregateField(
  fields: Record<string, number>,
  field: string,
  value: number | undefined,
): void {
  if (value !== undefined && Number.isFinite(value)) {
    fields[field] = value;
  }
}

/**
 * The channel-level parts every as-of read produces: one channel's value at the
 * anchor instant, its channel_key (→ parameter), and the quality/source/location
 * columns denormalized on sensor_metrics. Numeric columns arrive from the pg
 * driver as strings. This is the minimum assembleReading() needs.
 */
interface ChannelValueParts {
  channel_key: string;
  value: string | number | null;
  quality_code: number | null;
  source_protocol: string | null;
  pond_id: string | null;
  farm_id: string | null;
}

/**
 * A latest-per-channel row: a ChannelValueParts plus the sample's own time (Date
 * for comparison, lossless `time_text` for the federation-id anchor).
 */
interface ChannelAsOfRow extends ChannelValueParts {
  time: Date;
  time_text: string;
}

/** A batch latest-per-channel row additionally carries its owning sensor id. */
interface SensorChannelAsOfRow extends ChannelAsOfRow {
  sensor_id: string;
}

/** A range row: a ChannelValueParts forward-filled to an observation instant. */
interface RangeChannelAsOfRow extends ChannelValueParts {
  as_of: Date;
  as_of_text: string;
}

/** The newest (time, time_text) anchor among latest-per-channel rows, or null when empty. */
function latestAnchor(
  rows: ReadonlyArray<{ time: Date; time_text: string }>,
): { time: Date; timeText: string } | null {
  let best: { time: Date; timeText: string } | null = null;
  for (const row of rows) {
    if (!best || row.time.getTime() > best.time.getTime()) {
      best = { time: row.time, timeText: row.time_text };
    }
  }
  return best;
}

/**
 * The modal `source_protocol` across a reading's contributing channel rows
 * (SENSOR-HIGH-085 / D5). A projected reading has no single ingest source the
 * way a stored row did; the most common protocol among its channels is the
 * honest summary. Ties break on the lexicographically smallest protocol so the
 * value is deterministic. Returns undefined when no row carries a protocol.
 */
function modalSourceProtocol(rows: ReadonlyArray<{ source_protocol: string | null }>):
  | string
  | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const protocol = row.source_protocol;
    if (protocol) {
      counts.set(protocol, (counts.get(protocol) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [protocol, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === undefined || protocol < best))) {
      best = protocol;
      bestCount = count;
    }
  }
  return best;
}

/** First non-null value of a field across a reading's contributing rows. */
function firstNonNull<T>(rows: ReadonlyArray<T>, pick: (row: T) => string | null): string | undefined {
  for (const row of rows) {
    const value = pick(row);
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Sensor Query Service
 */
@Injectable()
export class SensorQueryService {
  private readonly logger = new Logger(SensorQueryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly dataQualityService: DataQualityService,
  ) {}

  /**
   * Latest reading for a sensor, as an as-of projection over sensor.sensor_metrics.
   *
   * SENSOR-HIGH-085: a SensorReading is no longer a stored row — it is the
   * last-known value of each of the sensor's channels. This takes, per channel,
   * the freshest metric sample (DISTINCT ON (channel_id) ... ORDER BY channel_id,
   * time DESC — an index descent on the (sensor_id, channel_id, time DESC) index)
   * and assembles them into one reading anchored at the newest of those
   * per-channel times. Device-ingested sensors (MQTT/edge/Rust) that never wrote
   * the retired sensor_readings store now return their real values. Runs inside a
   * tenant-pinned read (D8) so sensor_data_channels (per-tenant) resolves and the
   * cross-tenant sensor.sensor_metrics read is RLS-scoped.
   */
  async getLatestReading(
    sensorId: string,
    tenantId: string,
  ): Promise<SensorReading | null> {
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);

    return runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, async (qr) => {
      const rows = (await qr.query(
        `SELECT c.channel_key AS channel_key,
                m.value AS value,
                m.time AS time,
                m.time::text AS time_text,
                m.quality_code AS quality_code,
                m.source_protocol AS source_protocol,
                m.pond_id AS pond_id,
                m.farm_id AS farm_id
           FROM (
             SELECT DISTINCT ON (channel_id)
               channel_id, value, time, quality_code, source_protocol, pond_id, farm_id
             FROM sensor.sensor_metrics
             WHERE sensor_id = $1 AND tenant_id = $2
             ORDER BY channel_id, time DESC
           ) m
           JOIN sensor_data_channels c ON c.id = m.channel_id AND c.tenant_id = $2`,
        [validSensorId, validTenantId],
      )) as ChannelAsOfRow[];

      const anchor = latestAnchor(rows);
      if (!anchor) {
        return null;
      }
      return this.assembleReading(validSensorId, validTenantId, anchor.time, anchor.timeText, rows);
    });
  }

  /**
   * Readings across a time range, as an as-of series over sensor.sensor_metrics.
   *
   * SENSOR-HIGH-085: for the most recent `limit` distinct observation instants in
   * [start, end], each channel is forward-filled to its last-known value at or
   * before that instant (a per-channel LATERAL LIMIT 1 index seek), and the
   * per-instant snapshots are assembled into wide readings. For coherent
   * GraphQL/MQTT data — where every channel shares one `time` — this degenerates
   * to exactly one reading per original observation; for per-channel device data
   * it yields the faithful last-known-state at each instant something changed. The
   * observation instants are the wall-clock the reading is anchored at, so the
   * count is bounded by `limit` and each forward-fill is an index seek on the
   * (sensor_id, channel_id, time DESC) index. Ordered newest-first.
   */
  async getReadingsInRange(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    limit?: number,
  ): Promise<SensorReading[]> {
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);
    const { startTime: validStart, endTime: validEnd } = validateDateRange(
      startTime,
      endTime,
      MAX_QUERY_RANGE_MS,
    );
    const validLimit = validateLimit(limit, MAX_RESULTS_LIMIT);

    return runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, async (qr) => {
      const rows = (await qr.query(
        `WITH obs AS (
           SELECT DISTINCT time
           FROM sensor.sensor_metrics
           WHERE sensor_id = $1 AND tenant_id = $2 AND time BETWEEN $3 AND $4
           ORDER BY time DESC
           LIMIT $5
         )
         SELECT o.time AS as_of,
                o.time::text AS as_of_text,
                c.channel_key AS channel_key,
                lv.value AS value,
                lv.quality_code AS quality_code,
                lv.source_protocol AS source_protocol,
                lv.pond_id AS pond_id,
                lv.farm_id AS farm_id
           FROM obs o
           JOIN sensor_data_channels c ON c.sensor_id = $1 AND c.tenant_id = $2
           CROSS JOIN LATERAL (
             SELECT value, quality_code, source_protocol, pond_id, farm_id
             FROM sensor.sensor_metrics m
             WHERE m.sensor_id = $1 AND m.channel_id = c.id AND m.tenant_id = $2
               AND m.time <= o.time
             ORDER BY m.time DESC
             LIMIT 1
           ) lv
           ORDER BY o.time DESC`,
        [validSensorId, validTenantId, validStart, validEnd, validLimit],
      )) as RangeChannelAsOfRow[];

      // Rows arrive newest-first; group by observation instant preserving that
      // order so the returned readings are DESC by timestamp.
      const byInstant = new Map<string, { as_of: Date; rows: RangeChannelAsOfRow[] }>();
      for (const row of rows) {
        let group = byInstant.get(row.as_of_text);
        if (!group) {
          group = { as_of: row.as_of, rows: [] };
          byInstant.set(row.as_of_text, group);
        }
        group.rows.push(row);
      }

      return [...byInstant.entries()].map(([asOfText, group]) =>
        this.assembleReading(validSensorId, validTenantId, group.as_of, asOfText, group.rows),
      );
    });
  }

  /**
   * Get aggregated readings with full min/max for all metrics
   * Optimized for frontend chart rendering
   *
   * SECURITY: Uses parameterized queries and whitelist validation for interval
   */
  async getAggregatedReadings(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    interval?: AggregationInterval,
  ): Promise<AggregatedReadingsResponse> {
    // Validate all inputs
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);
    const { startTime: validStart, endTime: validEnd } = validateDateRange(
      startTime,
      endTime,
      MAX_QUERY_RANGE_MS,
    );

    // Auto-select optimal interval if not provided
    const effectiveInterval = interval
      ? validateAggregationInterval(interval)
      : getOptimalInterval(validStart, validEnd);

    if (!effectiveInterval) {
      throw new BadRequestException(
        `Invalid interval. Allowed values: ${ALLOWED_AGGREGATION_INTERVALS.join(', ')}`,
      );
    }

    // SENSOR-MEDIUM-066/068: aggregate over the converged channel-keyed
    // sensor.sensor_metrics store instead of extracting from the sensor_readings
    // JSONB. Large ranges read a pre-rolled continuous aggregate (metrics_1min/
    // 1hour/1day) so a month-long chart no longer scans raw rows; the ≤1h range
    // reads the raw hypertable. channel_key → parameter mapping uses the single
    // event-contract SSoT (parameterForChannelKey), so no alias list is
    // duplicated into SQL. This read returns the plain AggregatedReadingsResponse
    // (not the federated SensorReading entity), so it carries no reading id and
    // the supergraph contract is untouched.
    const source = selectMetricSource(validStart, validEnd);
    const avgExpr = source.weighted
      ? 'SUM(s.avg_value * s.sample_count) / NULLIF(SUM(s.sample_count), 0)'
      : 'AVG(s.value)';
    const minExpr = source.weighted ? 'MIN(s.min_value)' : 'MIN(s.value)';
    const maxExpr = source.weighted ? 'MAX(s.max_value)' : 'MAX(s.value)';
    const countExpr = source.weighted ? 'SUM(s.sample_count)' : 'COUNT(*)';

    // sensor/tenant/time filters are parameterized; the table + time column come
    // from the fixed selectMetricSource whitelist (never user input). The channel
    // JOIN + s.tenant_id filter keep the read tenant-isolated (sensor_metrics is
    // cross-tenant; sensor_data_channels is per-tenant via search_path).
    const query = `
      SELECT
        time_bucket($1::interval, s.${source.timeColumn}) AS bucket,
        c.channel_key AS channel_key,
        ${avgExpr} AS avg_value,
        ${minExpr} AS min_value,
        ${maxExpr} AS max_value,
        ${countExpr} AS sample_count
      FROM ${source.table} s
      JOIN sensor_data_channels c ON c.id = s.channel_id
      WHERE s.sensor_id = $2
        AND s.tenant_id = $3
        AND s.${source.timeColumn} >= $4
        AND s.${source.timeColumn} <= $5
      GROUP BY bucket, c.channel_key
      ORDER BY bucket ASC
    `;

    const rows: Array<{
      bucket: string;
      channel_key: string;
      avg_value: string | number | null;
      min_value: string | number | null;
      max_value: string | number | null;
      sample_count: string | number | null;
    }> = await this.dataSource.query(query, [
      effectiveInterval,
      validSensorId,
      validTenantId,
      validStart,
      validEnd,
    ]);

    const data = this.pivotChannelAggregates(rows);

    // Get sensor name with error handling
    let sensorName: string | undefined;
    try {
      const sensor: Array<{ name: string }> = await this.dataSource.query(
        `SELECT name FROM sensors WHERE id = $1 AND tenant_id = $2`,
        [validSensorId, validTenantId],
      );
      sensorName = sensor[0]?.name;
    } catch {
      // Sensor name is optional, don't fail the query
      this.logger.debug(`Could not fetch sensor name for ${validSensorId}`);
    }

    return {
      sensorId: validSensorId,
      sensorName,
      interval: effectiveInterval,
      startTime: validStart,
      endTime: validEnd,
      totalDataPoints: data.length,
      data,
    };
  }

  /**
   * Pivot the channel-keyed aggregate rows into the parameter-keyed
   * AggregatedReadingType[] the chart contract expects. Rows for channels
   * outside the nine-parameter vocabulary (parameterForChannelKey → undefined)
   * are skipped. When more than one channel maps to the same parameter within a
   * bucket their partials are merged (sample-count-weighted avg, min of mins,
   * max of maxes) so no channel's data is silently dropped. `count` is the
   * largest per-parameter sample count in the bucket — the closest proxy for the
   * reading-cycle count the previous JSONB-row COUNT(*) reported.
   */
  private pivotChannelAggregates(
    rows: Array<{
      bucket: string;
      channel_key: string;
      avg_value: string | number | null;
      min_value: string | number | null;
      max_value: string | number | null;
      sample_count: string | number | null;
    }>,
  ): AggregatedReadingType[] {
    interface ParamAccum {
      avgWeighted: number;
      count: number;
      min: number;
      max: number;
    }
    interface BucketAccum {
      bucket: Date;
      params: Map<SensorReadingParameter, ParamAccum>;
      maxCount: number;
    }
    const byBucket = new Map<number, BucketAccum>();

    for (const row of rows) {
      const parameter = parameterForChannelKey(row.channel_key);
      if (!parameter) continue;

      const avg = toNumberOrUndefined(row.avg_value);
      if (avg === undefined) continue;
      const min = toNumberOrUndefined(row.min_value);
      const max = toNumberOrUndefined(row.max_value);
      // COUNT(*) / SUM(sample_count) are ≥1 for any returned row; clamp defends
      // the weighting against a stray null so a present avg is never dropped.
      const count = Math.max(1, toNumberOrUndefined(row.sample_count) ?? 1);

      const bucketDate = new Date(row.bucket);
      const bucketKey = bucketDate.getTime();
      let bucket = byBucket.get(bucketKey);
      if (!bucket) {
        bucket = { bucket: bucketDate, params: new Map(), maxCount: 0 };
        byBucket.set(bucketKey, bucket);
      }

      const acc = bucket.params.get(parameter) ?? {
        avgWeighted: 0,
        count: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
      };
      acc.avgWeighted += avg * count;
      acc.count += count;
      if (min !== undefined) acc.min = Math.min(acc.min, min);
      if (max !== undefined) acc.max = Math.max(acc.max, max);
      bucket.params.set(parameter, acc);
      bucket.maxCount = Math.max(bucket.maxCount, acc.count);
    }

    return [...byBucket.values()]
      .sort((a, b) => a.bucket.getTime() - b.bucket.getTime())
      .map((bucket) => {
        const point: AggregatedReadingType = { bucket: bucket.bucket, count: bucket.maxCount };
        // Collect the dynamically-named parameter fields in a plain bag, then
        // graft them onto the typed point (Object.assign needs no cast).
        const fields: Record<string, number> = {};
        for (const [parameter, acc] of bucket.params) {
          const cap = parameter.charAt(0).toUpperCase() + parameter.slice(1);
          const avg = acc.count > 0 ? acc.avgWeighted / acc.count : undefined;
          setAggregateField(fields, `avg${cap}`, avg);
          if (MIN_MAX_PARAMETERS.has(parameter)) {
            setAggregateField(
              fields,
              `min${cap}`,
              acc.min === Number.POSITIVE_INFINITY ? undefined : acc.min,
            );
            setAggregateField(
              fields,
              `max${cap}`,
              acc.max === Number.NEGATIVE_INFINITY ? undefined : acc.max,
            );
          }
        }
        Object.assign(point, fields);
        return point;
      });
  }

  /**
   * Multiple sensors' latest readings, each an as-of projection (SENSOR-HIGH-085).
   *
   * DISTINCT ON (sensor_id, channel_id) ... ORDER BY sensor_id, channel_id, time
   * DESC gives every sensor's latest value per channel in a single index scan on
   * (sensor_id, channel_id, time DESC); the rows are grouped per sensor and each
   * sensor's reading is anchored at its newest channel time. Runs tenant-pinned
   * (D8). One reading per sensor that has any metric data.
   */
  async getLatestReadingsForSensors(
    sensorIds: string[],
    tenantId: string,
  ): Promise<SensorReading[]> {
    if (sensorIds.length === 0) {
      return [];
    }

    const validTenantId = validateTenantId(tenantId);
    const validSensorIds = sensorIds.map((id) => validateSensorId(id));

    // Cap batch size to prevent excessive query cost
    if (validSensorIds.length > 100) {
      throw new BadRequestException(
        'Maximum 100 sensors can be queried at once in a batch',
      );
    }

    return runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, async (qr) => {
      const rows = (await qr.query(
        `SELECT m.sensor_id AS sensor_id,
                c.channel_key AS channel_key,
                m.value AS value,
                m.time AS time,
                m.time::text AS time_text,
                m.quality_code AS quality_code,
                m.source_protocol AS source_protocol,
                m.pond_id AS pond_id,
                m.farm_id AS farm_id
           FROM (
             SELECT DISTINCT ON (sensor_id, channel_id)
               sensor_id, channel_id, value, time, quality_code, source_protocol, pond_id, farm_id
             FROM sensor.sensor_metrics
             WHERE sensor_id = ANY($1) AND tenant_id = $2
             ORDER BY sensor_id, channel_id, time DESC
           ) m
           JOIN sensor_data_channels c ON c.id = m.channel_id AND c.tenant_id = $2`,
        [validSensorIds, validTenantId],
      )) as SensorChannelAsOfRow[];

      const bySensor = new Map<string, SensorChannelAsOfRow[]>();
      for (const row of rows) {
        const list = bySensor.get(row.sensor_id) ?? [];
        list.push(row);
        bySensor.set(row.sensor_id, list);
      }

      const readings: SensorReading[] = [];
      for (const [sensorId, sensorRows] of bySensor) {
        const anchor = latestAnchor(sensorRows);
        if (!anchor) {
          continue;
        }
        readings.push(
          this.assembleReading(sensorId, validTenantId, anchor.time, anchor.timeText, sensorRows),
        );
      }
      return readings;
    });
  }

  /**
   * Reconstruct the exact as-of snapshot a federation id was minted from
   * (SENSOR-HIGH-085). SensorReadingResolver.resolveReference decodes an id into
   * (sensorId, anchor timeText) and calls this: for each of the sensor's channels
   * it takes the last-known value at or before the anchor instant (a per-channel
   * LATERAL LIMIT 1 index seek) and assembles the reading anchored at that exact
   * instant, so the reconstructed reading's id round-trips back to the input id.
   * Runs tenant-pinned (D8); `timeText` is fed back verbatim as a $::timestamptz
   * bound parameter, so the microsecond-precise `time <= T` bound is lossless.
   */
  async reconstructAsOf(
    sensorId: string,
    timeText: string,
    tenantId: string,
  ): Promise<SensorReading | null> {
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);

    return runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, async (qr) => {
      const rows = (await qr.query(
        `SELECT $3::timestamptz AS as_of,
                c.channel_key AS channel_key,
                lv.value AS value,
                lv.quality_code AS quality_code,
                lv.source_protocol AS source_protocol,
                lv.pond_id AS pond_id,
                lv.farm_id AS farm_id
           FROM sensor_data_channels c
           CROSS JOIN LATERAL (
             SELECT value, quality_code, source_protocol, pond_id, farm_id
             FROM sensor.sensor_metrics m
             WHERE m.sensor_id = $1 AND m.channel_id = c.id AND m.tenant_id = $2
               AND m.time <= $3::timestamptz
             ORDER BY m.time DESC
             LIMIT 1
           ) lv
           WHERE c.sensor_id = $1 AND c.tenant_id = $2`,
        [validSensorId, validTenantId, timeText],
      )) as Array<ChannelValueParts & { as_of: Date }>;

      if (rows.length === 0) {
        return null;
      }
      return this.assembleReading(validSensorId, validTenantId, rows[0]!.as_of, timeText, rows);
    });
  }

  /**
   * Assemble the channel-level as-of rows for one instant into a SensorReading
   * read-model (SENSOR-HIGH-085). channel_key → parameter via the event-contract
   * SSoT; quality is recomputed from the projected readings by the same
   * DataQualityService the ingest path used (D4); source is the modal channel
   * protocol (D5); id encodes (sensorId, anchor) via the shared codec (D3).
   */
  private assembleReading(
    sensorId: string,
    tenantId: string,
    anchorTime: Date,
    anchorTimeText: string,
    rows: ReadonlyArray<ChannelValueParts>,
  ): SensorReading {
    const readings: SensorReadings = {};
    for (const row of rows) {
      const parameter = parameterForChannelKey(row.channel_key);
      if (!parameter) {
        continue;
      }
      const value = toNumberOrUndefined(row.value);
      if (value === undefined) {
        continue;
      }
      readings[parameter] = value;
    }

    return {
      id: encodeSensorReadingId(sensorId, anchorTimeText),
      sensorId,
      tenantId,
      timestamp: anchorTime,
      readings,
      pondId: firstNonNull(rows, (r) => r.pond_id),
      farmId: firstNonNull(rows, (r) => r.farm_id),
      quality: this.dataQualityService.calculateQuality(readings),
      source: modalSourceProtocol(rows),
      createdAt: anchorTime,
    };
  }
}
