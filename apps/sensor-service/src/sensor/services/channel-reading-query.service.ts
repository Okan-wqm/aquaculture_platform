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
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, QueryRunner } from 'typeorm';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import {
  ChannelAlertLevel,
  ChannelLatestValue,
  ChannelSeries,
  ChannelSeriesResponse,
} from '../dto/channel-reading.dto';
import {
  validateAggregationInterval,
  validateDateRange,
  validateSensorId,
  validateTenantId,
  ALLOWED_AGGREGATION_INTERVALS,
} from '../validation/input-sanitizer';
import {
  AS_OF_LOOKBACK,
  bucketAggregateExpressions,
  resolveExistingSource,
  selectMetricSource,
  toNumberOrUndefined,
} from './metric-source';
import { getOptimalInterval } from './sensor-query.service';

/** The `sensor` source schema runInTenantRead pins alongside the tenant schema. */
const SENSOR_SCHEMA = 'sensor';
/** Same batch cap as latestReadingsBatch. */
const MAX_SENSORS_PER_BATCH = 100;
/** Same range cap as aggregatedReadings. */
const MAX_QUERY_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

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
}

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
   * Bucketed history of every enabled channel of one sensor. The source tier
   * (raw / 1min / 1hour / 1day) follows the range; the bucket width is the
   * requested interval or the range's optimal one.
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
      MAX_QUERY_RANGE_MS,
    );
    const effectiveInterval = interval
      ? validateAggregationInterval(interval)
      : getOptimalInterval(validStart, validEnd);
    if (!effectiveInterval) {
      throw new BadRequestException(
        `Invalid interval. Allowed values: ${ALLOWED_AGGREGATION_INTERVALS.join(', ')}`,
      );
    }

    const channels = await runInTenantRead(
      this.dataSource,
      SENSOR_SCHEMA,
      validTenantId,
      async (qr) => {
        const enabled = await this.enabledChannels(qr, [validSensorId]);
        if (enabled.length === 0) {
          return [];
        }
        const source = await resolveExistingSource(
          qr,
          selectMetricSource(validStart, validEnd),
          this.logger,
        );
        const agg = bucketAggregateExpressions(source);
        // The table and time column come from the fixed metric-source
        // whitelist (never user input); everything else is a bound parameter.
        const rows = (await qr.query(
          `SELECT s.channel_id AS channel_id,
                  time_bucket($1::interval, s.${source.timeColumn}) AS bucket,
                  ${agg.avg} AS avg_value,
                  ${agg.min} AS min_value,
                  ${agg.max} AS max_value,
                  ${agg.count} AS sample_count
             FROM ${source.table} s
            WHERE s.sensor_id = $2
              AND s.tenant_id = $3
              AND s.channel_id = ANY($4)
              AND s.${source.timeColumn} >= $5
              AND s.${source.timeColumn} <= $6
            GROUP BY s.channel_id, bucket
            ORDER BY bucket ASC`,
          [
            effectiveInterval,
            validSensorId,
            validTenantId,
            enabled.map((channel) => channel.id),
            validStart,
            validEnd,
          ],
        )) as SeriesRow[];
        return enabled.map((channel) => toSeries(channel, rows));
      },
    );

    return {
      sensorId: validSensorId,
      interval: effectiveInterval,
      startTime: validStart,
      endTime: validEnd,
      channels,
    };
  }

  private enabledChannels(qr: QueryRunner, sensorIds: string[]): Promise<SensorDataChannel[]> {
    return tenantManagerRepo(qr.manager, SensorDataChannel).find({
      where: { sensorId: In(sensorIds), isEnabled: true },
      order: { sensorId: 'ASC', displayOrder: 'ASC', channelKey: 'ASC' },
    });
  }
}

function toSeries(channel: SensorDataChannel, rows: readonly SeriesRow[]): ChannelSeries {
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
    });
  }
  return { channelId: channel.id, channelKey: channel.channelKey, points };
}
