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

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { parameterForChannelKey, type SensorReadingParameter } from '@platform/event-contracts';
import { Repository, Between, DataSource } from 'typeorm';

import {
  SensorReading,
  SensorReadings,
} from '../../database/entities/sensor-reading.entity';
import {
  AggregatedReadingType,
  AggregatedReadingsResponse,
} from '../dto/aggregated-reading.dto';
import {
  validateSensorId,
  validateTenantId,
  validateAggregationInterval,
  validateDateRange,
  validateLimit,
  ALLOWED_AGGREGATION_INTERVALS,
  SafeAggregationInterval,
} from '../validation/input-sanitizer';

/**
 * Aggregation interval type - restricted to whitelist
 */
export type AggregationInterval = SafeAggregationInterval;

/**
 * Query result row for aggregated readings
 */
interface AggregatedReadingRow {
  bucket: Date;
  count: string;
  avg_temperature?: string;
  avg_ph?: string;
  avg_dissolved_oxygen?: string;
  avg_salinity?: string;
  avg_ammonia?: string;
  avg_nitrite?: string;
  avg_nitrate?: string;
  avg_turbidity?: string;
  avg_water_level?: string;
  min_temperature?: string;
  max_temperature?: string;
  min_ph?: string;
  max_ph?: string;
  min_dissolved_oxygen?: string;
  max_dissolved_oxygen?: string;
  min_salinity?: string;
  max_salinity?: string;
  min_ammonia?: string;
  max_ammonia?: string;
}

/**
 * Query result row for sensor stats
 */
interface SensorStatsRow {
  total_readings: string;
  average_quality: string | null;
  last_reading: Date | null;
}

/**
 * Aggregated sensor data
 */
export interface AggregatedSensorData {
  bucket: Date;
  averages: SensorReadings;
  minimums?: SensorReadings;
  maximums?: SensorReadings;
  count: number;
}

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

/**
 * Safely parse numeric string to number or undefined
 */
function parseNumericOrUndefined(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : undefined;
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
 * Sensor Query Service
 */
@Injectable()
export class SensorQueryService {
  private readonly logger = new Logger(SensorQueryService.name);

  constructor(
    @InjectRepository(SensorReading)
    private readonly readingRepository: Repository<SensorReading>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get the latest reading for a sensor
   */
  async getLatestReading(
    sensorId: string,
    tenantId: string,
  ): Promise<SensorReading | null> {
    // Validate inputs
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);

    return await this.readingRepository.findOne({
      where: { sensorId: validSensorId, tenantId: validTenantId },
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Get readings within a time range
   */
  async getReadingsInRange(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    limit?: number,
  ): Promise<SensorReading[]> {
    // Validate inputs
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);
    const { startTime: validStart, endTime: validEnd } = validateDateRange(
      startTime,
      endTime,
      MAX_QUERY_RANGE_MS,
    );
    const validLimit = validateLimit(limit, MAX_RESULTS_LIMIT);

    return await this.readingRepository.find({
      where: {
        sensorId: validSensorId,
        tenantId: validTenantId,
        timestamp: Between(validStart, validEnd),
      },
      order: { timestamp: 'DESC' },
      take: validLimit,
    });
  }

  /**
   * Get aggregated data using TimescaleDB time_bucket
   * This provides efficient time-series aggregation
   *
   * SECURITY: Uses parameterized queries and whitelist validation for interval
   */
  async getAggregatedData(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    interval: AggregationInterval,
  ): Promise<AggregatedSensorData[]> {
    // Validate all inputs
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);
    const { startTime: validStart, endTime: validEnd } = validateDateRange(
      startTime,
      endTime,
      MAX_QUERY_RANGE_MS,
    );
    const validInterval = validateAggregationInterval(interval);

    if (!validInterval) {
      throw new BadRequestException(
        `Invalid interval. Allowed values: ${ALLOWED_AGGREGATION_INTERVALS.join(', ')}`,
      );
    }

    // Parameterized query - interval is validated against whitelist
    const query = `
      SELECT
        time_bucket($1::interval, timestamp) AS bucket,
        COUNT(*) AS count,
        AVG((readings->>'temperature')::numeric) AS avg_temperature,
        AVG((readings->>'ph')::numeric) AS avg_ph,
        AVG((readings->>'dissolvedOxygen')::numeric) AS avg_dissolved_oxygen,
        AVG((readings->>'salinity')::numeric) AS avg_salinity,
        AVG((readings->>'ammonia')::numeric) AS avg_ammonia,
        AVG((readings->>'nitrite')::numeric) AS avg_nitrite,
        AVG((readings->>'nitrate')::numeric) AS avg_nitrate,
        MIN((readings->>'temperature')::numeric) AS min_temperature,
        MAX((readings->>'temperature')::numeric) AS max_temperature
      FROM sensor_readings
      WHERE sensor_id = $2
        AND tenant_id = $3
        AND timestamp BETWEEN $4 AND $5
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const results = await this.dataSource.query<AggregatedReadingRow[]>(query, [
      validInterval,
      validSensorId,
      validTenantId,
      validStart,
      validEnd,
    ]);

    return results.map((row: AggregatedReadingRow) => ({
      bucket: row.bucket,
      count: parseInt(row.count, 10),
      averages: {
        temperature: parseNumericOrUndefined(row.avg_temperature),
        ph: parseNumericOrUndefined(row.avg_ph),
        dissolvedOxygen: parseNumericOrUndefined(row.avg_dissolved_oxygen),
        salinity: parseNumericOrUndefined(row.avg_salinity),
        ammonia: parseNumericOrUndefined(row.avg_ammonia),
        nitrite: parseNumericOrUndefined(row.avg_nitrite),
        nitrate: parseNumericOrUndefined(row.avg_nitrate),
      },
      minimums: {
        temperature: parseNumericOrUndefined(row.min_temperature),
      },
      maximums: {
        temperature: parseNumericOrUndefined(row.max_temperature),
      },
    }));
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
   * Get readings for a pond (all sensors in a pond)
   */
  async getPondReadings(
    pondId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<SensorReading[]> {
    // Validate inputs
    const validPondId = validateSensorId(pondId); // UUID format
    const validTenantId = validateTenantId(tenantId);
    const { startTime: validStart, endTime: validEnd } = validateDateRange(
      startTime,
      endTime,
      MAX_QUERY_RANGE_MS,
    );

    return await this.readingRepository.find({
      where: {
        pondId: validPondId,
        tenantId: validTenantId,
        timestamp: Between(validStart, validEnd),
      },
      order: { timestamp: 'ASC' },
      take: 5000,
    });
  }

  /**
   * Get reading statistics for a sensor
   */
  async getSensorStatistics(
    sensorId: string,
    tenantId: string,
    days = 7,
  ): Promise<{
    totalReadings: number;
    averageQuality: number;
    lastReading: Date | null;
    readingsPerDay: number;
  }> {
    // Validate inputs
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);

    // Validate days parameter
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new BadRequestException('Days must be an integer between 1 and 365');
    }

    const startTime = new Date();
    startTime.setDate(startTime.getDate() - days);

    const query = `
      SELECT
        COUNT(*) AS total_readings,
        AVG(quality) AS average_quality,
        MAX(timestamp) AS last_reading
      FROM sensor_readings
      WHERE sensor_id = $1
        AND tenant_id = $2
        AND timestamp >= $3
    `;

    const results: SensorStatsRow[] = await this.dataSource.query(query, [
      validSensorId,
      validTenantId,
      startTime,
    ]);

    const result = results[0];
    const totalReadings = parseInt(result?.total_readings || '0', 10);

    return {
      totalReadings,
      averageQuality: result?.average_quality
        ? parseFloat(result.average_quality)
        : 0,
      lastReading: result?.last_reading || null,
      readingsPerDay: days > 0 ? totalReadings / days : 0,
    };
  }

  /**
   * Get multiple sensors' latest readings efficiently
   * Useful for dashboard views
   *
   * Uses DISTINCT ON for a single-pass scan — no N+1 queries.
   * Raw SQL returns snake_case columns, so we alias them to match the entity.
   */
  async getLatestReadingsForSensors(
    sensorIds: string[],
    tenantId: string,
  ): Promise<SensorReading[]> {
    if (sensorIds.length === 0) {
      return [];
    }

    // Validate inputs
    const validTenantId = validateTenantId(tenantId);
    const validSensorIds = sensorIds.map((id) => validateSensorId(id));

    // Cap batch size to prevent excessive query cost
    if (validSensorIds.length > 100) {
      throw new BadRequestException(
        'Maximum 100 sensors can be queried at once in a batch',
      );
    }

    // Use DISTINCT ON for PostgreSQL to get latest reading per sensor
    // Alias snake_case columns to camelCase to match the SensorReading entity
    const query = `
      SELECT DISTINCT ON (sensor_id)
        id,
        sensor_id    AS "sensorId",
        tenant_id    AS "tenantId",
        timestamp,
        readings,
        pond_id      AS "pondId",
        farm_id      AS "farmId",
        quality,
        source,
        created_at   AS "createdAt"
      FROM sensor_readings
      WHERE sensor_id = ANY($1)
        AND tenant_id = $2
      ORDER BY sensor_id, timestamp DESC
    `;

    const results: SensorReading[] = await this.dataSource.query(query, [
      validSensorIds,
      validTenantId,
    ]);

    return results;
  }

  /**
   * Get aggregated readings for multiple sensors
   * Useful for comparing sensors
   */
  async getMultiSensorAggregatedReadings(
    sensorIds: string[],
    tenantId: string,
    startTime: Date,
    endTime: Date,
    interval?: AggregationInterval,
  ): Promise<Map<string, AggregatedReadingsResponse>> {
    if (sensorIds.length === 0) {
      return new Map();
    }

    // Limit to prevent performance issues
    if (sensorIds.length > 10) {
      throw new BadRequestException('Maximum 10 sensors can be queried at once');
    }

    const resultsMap = new Map<string, AggregatedReadingsResponse>();

    // Fetch in parallel but with controlled concurrency
    const promises = sensorIds.map((sensorId) =>
      this.getAggregatedReadings(sensorId, tenantId, startTime, endTime, interval)
        .then((result) => ({ sensorId, result, error: null }))
        .catch((error) => ({ sensorId, result: null, error })),
    );

    const results = await Promise.all(promises);

    for (const { sensorId, result, error } of results) {
      if (result) {
        resultsMap.set(sensorId, result);
      } else {
        this.logger.warn(`Failed to get readings for sensor ${sensorId}: ${error?.message}`);
      }
    }

    return resultsMap;
  }
}
