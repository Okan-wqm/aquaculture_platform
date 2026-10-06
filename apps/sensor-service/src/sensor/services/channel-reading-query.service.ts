/**
 * Channel-generic reads over sensor_metrics (SENSOR-HIGH-138).
 *
 * SensorQueryService projects readings into a fixed nine-parameter shape; a
 * channel outside that vocabulary is invisible to it. This service reads by
 * channel: a sensor's enabled sensor_data_channels rows define what comes
 * back, each with its last-known value or its bucketed history. Tier
 * selection, the freshness bound and rollup re-bucketing come from
 * metric-source.ts, the same rules the nine-parameter projection uses.
 */

import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  AGGREGATION_INTERVALS,
  type AggregationIntervalSql,
  MAX_SERIES_RANGE_MS,
  SERIES_QUERY_TIMEOUT,
} from '@aquaculture/shared-contracts/sensor-readings/tier-policy';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, QueryRunner } from 'typeorm';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { aggregationIntervalOf } from '../dto/aggregated-reading.dto';
import {
  ChannelAlertLevel,
  ChannelDataBounds,
  ChannelLatestValue,
  ChannelSeries,
  ChannelSeriesResponse,
  metricSourceTierOf,
  TimeWindow,
} from '../dto/channel-reading.dto';
import {
  validateAggregationInterval,
  validateDateRange,
  validateSensorId,
  validateTenantId,
} from '../validation/input-sanitizer';
import {
  AS_OF_LOOKBACK,
  bucketAggregateExpressions,
  METRIC_ROLLUP_SOURCES,
  planMetricRead,
  resolveExistingSource,
  scanStart,
  tierOfSource,
  toNumberOrUndefined,
} from './metric-source';

/** The `sensor` source schema runInTenantRead pins alongside the tenant schema. */
const SENSOR_SCHEMA = 'sensor';
/** Same batch cap as latestReadingsBatch. */
const MAX_SENSORS_PER_BATCH = 100;

const ALERT_LEVELS: Readonly<Record<'normal' | 'warning' | 'critical', ChannelAlertLevel>> = {
  normal: ChannelAlertLevel.NORMAL,
  warning: ChannelAlertLevel.WARNING,
  critical: ChannelAlertLevel.CRITICAL,
};

interface LatestRow {
  channel_id: string;
  value: string | number | null;
  time: Date;
  quality_code: number | null;
}

interface SeriesRow {
  channel_id: string;
  bucket: Date;
  avg_value: string | number | null;
  min_value: string | number | null;
  max_value: string | number | null;
  sample_count: string | number | null;
  bad_count: string | number | null;
}

/** History reads fail fast instead of holding a pooled connection. */
const SERIES_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${SERIES_QUERY_TIMEOUT.sql}'`;

@Injectable()
export class ChannelReadingQueryService {
  private readonly logger = new Logger(ChannelReadingQueryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Every enabled channel of the given sensors with its last-known value
   * inside AS_OF_LOOKBACK. A channel with nothing in the window is returned
   * with a null value, so the client can show "no data" rather than lose it.
   */
  async getLatestValues(sensorIds: string[], tenantId: string): Promise<ChannelLatestValue[]> {
    if (sensorIds.length === 0) {
      return [];
    }
    if (sensorIds.length > MAX_SENSORS_PER_BATCH) {
      throw new BadRequestException(
        `Maximum ${MAX_SENSORS_PER_BATCH} sensors can be queried at once`,
      );
    }
    const validTenantId = validateTenantId(tenantId);
    const validSensorIds = sensorIds.map((id) => validateSensorId(id));

    return runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, async (qr) => {
      const channels = await this.enabledChannels(qr, validSensorIds);
      if (channels.length === 0) {
        return [];
      }

      // Per-channel LIMIT 1 index seek, bounded by the freshness window so
      // TimescaleDB prunes chunks (see AS_OF_LOOKBACK).
      const rows = (await qr.query(
        `SELECT c.id AS channel_id, lv.value, lv.time, lv.quality_code
           FROM sensor_data_channels c
           CROSS JOIN LATERAL (
             SELECT m.value, m.time, m.quality_code
               FROM sensor_metrics m
              WHERE m.sensor_id = c.sensor_id AND m.channel_id = c.id AND m.tenant_id = $2
                AND m.time >= NOW() - $3::interval
              ORDER BY m.time DESC
              LIMIT 1
           ) lv
          WHERE c.id = ANY($1) AND c.tenant_id = $2`,
        [channels.map((channel) => channel.id), validTenantId, AS_OF_LOOKBACK],
      )) as LatestRow[];
      const latestByChannel = new Map(rows.map((row) => [row.channel_id, row]));

      return channels.map((channel) => {
        const latest = latestByChannel.get(channel.id);
        const value = toNumberOrUndefined(latest?.value);
        return {
          sensorId: channel.sensorId,
          channelId: channel.id,
          channelKey: channel.channelKey,
          displayLabel: channel.displayLabel,
          unit: channel.unit ?? undefined,
          unitSymbol: channel.unitSymbol ?? undefined,
          displayOrder: channel.displayOrder,
          precision: channel.displaySettings?.precision,
          value,
          time: value === undefined ? undefined : latest?.time,
          qualityCode: latest?.quality_code ?? undefined,
          alertLevel: value === undefined ? undefined : ALERT_LEVELS[channel.getAlertLevel(value)],
        };
      });
    });
  }

  /**
   * Bucketed history of every channel of one sensor — disabled ones too, so a
   * probe switched off after an incident keeps its record — read through the
   * tier policy's plan: the store follows the range and the data's age, and
   * the width returned is never finer than the store keeps. The response says
   * which store and width it used, and where the range holds no data.
   */
  async getSeries(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    interval?: string,
  ): Promise<ChannelSeriesResponse> {
    const validSensorId = validateSensorId(sensorId);
    const validTenantId = validateTenantId(tenantId);
    const { startTime: validStart, endTime: validEnd } = validateDateRange(
      startTime,
      endTime,
      MAX_SERIES_RANGE_MS,
    );
    const plan = planMetricRead(validStart, validEnd, validateAggregationInterval(interval));
    const intervalMs = intervalMsOf(plan.interval);

    const { channels, tier } = await runInTenantRead(
      this.dataSource,
      SENSOR_SCHEMA,
      validTenantId,
      async (qr) => {
        await qr.query(SERIES_TIMEOUT_SQL);
        const sensorChannels = await this.allChannels(qr, [validSensorId]);
        const source = await resolveExistingSource(qr, plan.source, this.logger);
        if (sensorChannels.length === 0) {
          return { channels: [], tier: tierOfSource(source) };
        }
        const agg = bucketAggregateExpressions(source);
        // The table and time column come from the fixed tier-policy whitelist
        // (never user input); everything else is a bound parameter. The window
        // is [scanStart, end): a rollup bucket overlapping the start counts,
        // a bucket starting at the end does not.
        const rows = (await qr.query(
          `SELECT s.channel_id AS channel_id,
                  time_bucket($1::interval, s.${source.timeColumn}) AS bucket,
                  ${agg.avg} AS avg_value,
                  ${agg.min} AS min_value,
                  ${agg.max} AS max_value,
                  ${agg.count} AS sample_count,
                  ${agg.badCount} AS bad_count
             FROM ${source.table} s
            WHERE s.sensor_id = $2
              AND s.tenant_id = $3
              AND s.channel_id = ANY($4)
              AND s.${source.timeColumn} >= $5
              AND s.${source.timeColumn} < $6
            GROUP BY s.channel_id, bucket
            ORDER BY bucket ASC`,
          [
            plan.interval,
            validSensorId,
            validTenantId,
            sensorChannels.map((channel) => channel.id),
            scanStart(plan, source),
            validEnd,
          ],
        )) as SeriesRow[];
        return {
          channels: sensorChannels.map((channel) =>
            toSeries(channel, rows, { start: validStart, end: validEnd, intervalMs }),
          ),
          tier: tierOfSource(source),
        };
      },
    );

    return {
      sensorId: validSensorId,
      interval: plan.interval,
      resolution: aggregationIntervalOf(plan.interval),
      sourceTier: metricSourceTierOf(tier),
      // time_bucket without an origin or zone argument aligns buckets in UTC.
      bucketTimeZone: 'UTC',
      maxRangeSeconds: MAX_SERIES_RANGE_MS / 1000,
      startTime: validStart,
      endTime: validEnd,
      channels,
    };
  }

  /**
   * The first and last stored sample of every channel of the given sensors.
   * First comes from the daily rollup, which keeps every day indefinitely;
   * last from the freshness-bounded raw lookup, falling back to the daily
   * rollup for a channel quiet longer than that — so neither scans raw history.
   */
  async getDataBounds(sensorIds: string[], tenantId: string): Promise<ChannelDataBounds[]> {
    if (sensorIds.length === 0) {
      return [];
    }
    if (sensorIds.length > MAX_SENSORS_PER_BATCH) {
      throw new BadRequestException(
        `Maximum ${MAX_SENSORS_PER_BATCH} sensors can be queried at once`,
      );
    }
    const validTenantId = validateTenantId(tenantId);
    const validSensorIds = sensorIds.map((id) => validateSensorId(id));

    return runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, async (qr) => {
      await qr.query(SERIES_TIMEOUT_SQL);
      const channels = await this.allChannels(qr, validSensorIds);
      if (channels.length === 0) {
        return [];
      }
      const channelIds = channels.map((channel) => channel.id);
      const daily = await resolveExistingSource(qr, METRIC_ROLLUP_SOURCES.day, this.logger);
      const spans = (await qr.query(
        `SELECT s.channel_id AS channel_id,
                MIN(s.${daily.timeColumn}) AS first_at,
                MAX(s.${daily.timeColumn}) AS last_at
           FROM ${daily.table} s
          WHERE s.sensor_id = ANY($1) AND s.tenant_id = $2 AND s.channel_id = ANY($3)
          GROUP BY s.channel_id`,
        [validSensorIds, validTenantId, channelIds],
      )) as Array<{ channel_id: string; first_at: Date | null; last_at: Date | null }>;
      const recent = (await qr.query(
        `SELECT c.id AS channel_id, lv.time
           FROM sensor_data_channels c
           CROSS JOIN LATERAL (
             SELECT m.time FROM sensor_metrics m
              WHERE m.sensor_id = c.sensor_id AND m.channel_id = c.id AND m.tenant_id = $2
                AND m.time >= NOW() - $3::interval
              ORDER BY m.time DESC
              LIMIT 1
           ) lv
          WHERE c.id = ANY($1) AND c.tenant_id = $2`,
        [channelIds, validTenantId, AS_OF_LOOKBACK],
      )) as Array<{ channel_id: string; time: Date }>;
      const spanByChannel = new Map(spans.map((row) => [row.channel_id, row]));
      const recentByChannel = new Map(recent.map((row) => [row.channel_id, row.time]));

      return channels.map((channel) => {
        const span = spanByChannel.get(channel.id);
        return {
          sensorId: channel.sensorId,
          channelId: channel.id,
          firstSampleAt: span?.first_at ? new Date(span.first_at) : undefined,
          lastSampleAt: recentByChannel.has(channel.id)
            ? new Date(recentByChannel.get(channel.id) ?? 0)
            : span?.last_at
              ? new Date(span.last_at)
              : undefined,
        };
      });
    });
  }

  /** Every channel of the sensors, enabled or not — history outlives a switch-off. */
  private allChannels(qr: QueryRunner, sensorIds: string[]): Promise<SensorDataChannel[]> {
    return tenantManagerRepo(qr.manager, SensorDataChannel).find({
      where: { sensorId: In(sensorIds) },
      order: { sensorId: 'ASC', displayOrder: 'ASC', channelKey: 'ASC' },
    });
  }

  private enabledChannels(qr: QueryRunner, sensorIds: string[]): Promise<SensorDataChannel[]> {
    return tenantManagerRepo(qr.manager, SensorDataChannel).find({
      where: { sensorId: In(sensorIds), isEnabled: true },
      order: { sensorId: 'ASC', displayOrder: 'ASC', channelKey: 'ASC' },
    });
  }
}

function toSeries(
  channel: SensorDataChannel,
  rows: readonly SeriesRow[],
  range: { start: Date; end: Date; intervalMs: number },
): ChannelSeries {
  const points: ChannelSeries['points'] = [];
  for (const row of rows) {
    if (row.channel_id !== channel.id) continue;
    const avg = toNumberOrUndefined(row.avg_value);
    if (avg === undefined) continue;
    points.push({
      bucket: new Date(row.bucket),
      avg,
      min: toNumberOrUndefined(row.min_value),
      max: toNumberOrUndefined(row.max_value),
      count: toNumberOrUndefined(row.sample_count) ?? 0,
      badCount: toNumberOrUndefined(row.bad_count) ?? 0,
    });
  }
  return {
    channelId: channel.id,
    channelKey: channel.channelKey,
    displayLabel: channel.displayLabel,
    unit: channel.unit ?? undefined,
    unitSymbol: channel.unitSymbol ?? undefined,
    precision: channel.displaySettings?.precision,
    enabled: channel.isEnabled,
    points,
    gaps: gapsIn(points, range),
  };
}

/**
 * The stretches of [start, end) no bucket covers, at least one bucket wide.
 * Buckets come back aligned by the database, so the gaps are read off the
 * buckets that exist rather than recomputing the alignment here.
 */
export function gapsIn(
  points: readonly { bucket: Date }[],
  range: { start: Date; end: Date; intervalMs: number },
): TimeWindow[] {
  const gaps: TimeWindow[] = [];
  const { start, end, intervalMs } = range;
  if (points.length === 0) {
    return [{ start, end }];
  }
  const first = points[0]?.bucket ?? start;
  if (first.getTime() - start.getTime() >= intervalMs) {
    gaps.push({ start, end: first });
  }
  for (let index = 1; index < points.length; index++) {
    const previousEnd = (points[index - 1]?.bucket.getTime() ?? 0) + intervalMs;
    const next = points[index]?.bucket.getTime() ?? previousEnd;
    if (next > previousEnd) {
      gaps.push({ start: new Date(previousEnd), end: new Date(next) });
    }
  }
  const lastEnd = (points[points.length - 1]?.bucket.getTime() ?? 0) + intervalMs;
  if (end.getTime() - lastEnd >= intervalMs) {
    gaps.push({ start: new Date(lastEnd), end });
  }
  return gaps;
}

/** Milliseconds of a whitelisted interval. */
function intervalMsOf(sql: AggregationIntervalSql): number {
  const interval = AGGREGATION_INTERVALS.find((candidate) => candidate.sql === sql);
  if (interval === undefined) {
    throw new Error(`Not a policy interval: ${sql}`);
  }
  return interval.ms;
}
