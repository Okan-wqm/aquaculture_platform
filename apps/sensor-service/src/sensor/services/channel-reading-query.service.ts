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
import { MAX_SERIES_RANGE_MS, SERIES_QUERY_TIMEOUT } from '@aquaculture/shared-contracts';
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
  SeriesDisplayTimeZone,
  TimeWindow,
} from '../dto/channel-reading.dto';
import { SeriesTimeZoneService } from './series-time-zone.service';
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
  type MetricReadPlan,
  type MetricSource,
  planMetricRead,
  RAW_METRIC_SOURCE,
  resolveExistingSource,
  bucketingFor,
  scanStart,
  seriesBucketExpressions,
  tierOfSource,
  toNumberOrUndefined,
} from './metric-source';

/** The `sensor` source schema runInTenantRead pins alongside the tenant schema. */
const SENSOR_SCHEMA = 'sensor';
/** Same batch cap as latestReadingsBatch. */
const MAX_SENSORS_PER_BATCH = 100;
/**
 * The page zone reads only each sensor's site: cheap, so a whole page asks
 * at once. More than 100 distinct sites is mixed zones by definition, which
 * the zone rule answers with the tenant zone.
 */
const MAX_SENSORS_PER_ZONE = 1_000;

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
  bucket_end: Date;
}

/** History reads fail fast instead of holding a pooled connection. */
const SERIES_TIMEOUT_SQL = `SET LOCAL statement_timeout = '${SERIES_QUERY_TIMEOUT.sql}'`;

@Injectable()
export class ChannelReadingQueryService {
  private readonly logger = new Logger(ChannelReadingQueryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly seriesTimeZones: SeriesTimeZoneService,
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
    const requestedInterval = validateAggregationInterval(interval);

    // The zone is farm's answer for the sensor's site. The site is read first
    // and farm asked between the two reads, so no pooled connection waits on
    // NATS.
    const siteBySensor = await runInTenantRead(
      this.dataSource,
      SENSOR_SCHEMA,
      validTenantId,
      (qr) => this.seriesTimeZones.sitesOf(qr, [validSensorId]),
    );
    const candidate = await this.seriesTimeZones.candidate(validTenantId, siteBySensor);

    const { channels, tier, plan, zone } = await runInTenantRead(
      this.dataSource,
      SENSOR_SCHEMA,
      validTenantId,
      async (qr) => {
        await qr.query(SERIES_TIMEOUT_SQL);
        const seriesZone = await this.seriesTimeZones.validated(qr, candidate, {
          start: validStart,
          end: validEnd,
        });
        const readPlan = planMetricRead(
          validStart,
          validEnd,
          requestedInterval,
          new Date(),
          seriesZone.bucketZone,
        );
        const sensorChannels = await this.allChannels(qr, [validSensorId]);
        const read = await this.resolveSeriesRead(qr, readPlan);
        if (sensorChannels.length === 0) {
          return {
            channels: [],
            tier: tierOfSource(read.source),
            plan: read.plan,
            zone: seriesZone,
          };
        }
        const query = seriesQuery(read, {
          sensorId: validSensorId,
          tenantId: validTenantId,
          channelIds: sensorChannels.map((channel) => channel.id),
          windowStart: validStart,
          end: validEnd,
          zone: seriesZone.displayTimeZone,
        });
        const rows = (await qr.query(query.sql, query.params)) as SeriesRow[];
        return {
          channels: sensorChannels.map((channel) =>
            toSeries(channel, rows, { start: validStart, end: validEnd }),
          ),
          tier: tierOfSource(read.source),
          plan: read.plan,
          zone: seriesZone,
        };
      },
    );

    return {
      sensorId: validSensorId,
      interval: plan.interval,
      resolution: aggregationIntervalOf(plan.interval),
      sourceTier: metricSourceTierOf(tier),
      bucketTimeZone: plan.alignment === 'zone' ? zone.displayTimeZone : 'UTC',
      displayTimeZone: zone.displayTimeZone,
      displayTimeZoneSource: zone.source,
      maxRangeSeconds: MAX_SERIES_RANGE_MS / 1000,
      startTime: validStart,
      endTime: validEnd,
      channels,
    };
  }

  /**
   * The stores a plan reads, as they exist in this tenant. A missing rollup
   * falls back to raw rows (exact at any alignment); a plan that needs the
   * minute rows of boundary hours but finds no minute rollup reads raw too.
   */
  private async resolveSeriesRead(
    qr: QueryRunner,
    plan: MetricReadPlan,
  ): Promise<{ plan: MetricReadPlan; source: MetricSource; minuteSource: MetricSource | null }> {
    const source = await resolveExistingSource(qr, plan.source, this.logger);
    if (!plan.boundaryMinutes || source === RAW_METRIC_SOURCE) {
      return { plan: { ...plan, boundaryMinutes: false }, source, minuteSource: null };
    }
    const minute = await resolveExistingSource(qr, METRIC_ROLLUP_SOURCES.minute, this.logger);
    return minute === RAW_METRIC_SOURCE
      ? { plan: { ...plan, boundaryMinutes: false }, source: RAW_METRIC_SOURCE, minuteSource: null }
      : { plan, source, minuteSource: minute };
  }

  /**
   * The zone a page of these sensors' charts is shown and picked in, by the
   * same rule a series uses: their shared site zone, else the tenant's; UTC,
   * marked unavailable, when farm cannot answer.
   */
  async getDisplayTimeZone(sensorIds: string[], tenantId: string): Promise<SeriesDisplayTimeZone> {
    if (sensorIds.length > MAX_SENSORS_PER_ZONE) {
      throw new BadRequestException(
        `Maximum ${MAX_SENSORS_PER_ZONE} sensors can be asked about at once`,
      );
    }
    const validTenantId = validateTenantId(tenantId);
    const validSensorIds = sensorIds.map((id) => validateSensorId(id));
    const siteBySensor = await runInTenantRead(
      this.dataSource,
      SENSOR_SCHEMA,
      validTenantId,
      (qr) => this.seriesTimeZones.sitesOf(qr, validSensorIds),
    );
    const candidate = await this.seriesTimeZones.candidate(validTenantId, siteBySensor);
    // Only the zone's name and source are returned; the bucket facts (which
    // depend on a window) are not, so the check is made at this instant.
    const now = new Date();
    const zone = await runInTenantRead(this.dataSource, SENSOR_SCHEMA, validTenantId, (qr) =>
      this.seriesTimeZones.validated(qr, candidate, { start: now, end: now }),
    );
    return { displayTimeZone: zone.displayTimeZone, source: zone.source };
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

      // A channel quiet longer than the freshness window has only its last
      // daily bucket — a UTC midnight, up to a day before the real sample. Its
      // last sample is narrowed inside that day from the finest rollup that
      // still holds it (minute, else hour), so "last data" and the jump to it
      // land on the sample's own minute.
      const quiet = channels.flatMap((channel) => {
        const lastDay = spanByChannel.get(channel.id)?.last_at;
        return !recentByChannel.has(channel.id) && lastDay ? [{ id: channel.id, lastDay }] : [];
      });
      if (quiet.length > 0) {
        const minute = await resolveExistingSource(qr, METRIC_ROLLUP_SOURCES.minute, this.logger);
        const hour = await resolveExistingSource(qr, METRIC_ROLLUP_SOURCES.hour, this.logger);
        const latestIn = (source: MetricSource, alias: string): string =>
          `(SELECT MAX(${alias}.${source.timeColumn}) FROM ${source.table} ${alias}
             WHERE ${alias}.channel_id = q.id AND ${alias}.tenant_id = $3
               AND ${alias}.${source.timeColumn} >= q.last_day
               AND ${alias}.${source.timeColumn} < q.last_day + interval '1 day')`;
        const narrowed = (await qr.query(
          `SELECT q.id AS channel_id,
                  COALESCE(${latestIn(minute, 'm')}, ${latestIn(hour, 'h')}, q.last_day) AS last_at
             FROM unnest($1::uuid[], $2::timestamptz[]) AS q(id, last_day)`,
          [quiet.map((row) => row.id), quiet.map((row) => row.lastDay), validTenantId],
        )) as Array<{ channel_id: string; last_at: Date }>;
        for (const row of narrowed) recentByChannel.set(row.channel_id, row.last_at);
      }

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
  range: { start: Date; end: Date },
): ChannelSeries {
  const points: ChannelSeries['points'] = [];
  const spans: Array<{ bucket: Date; bucketEnd: Date }> = [];
  for (const row of rows) {
    if (row.channel_id !== channel.id) continue;
    const avg = toNumberOrUndefined(row.avg_value);
    if (avg === undefined) continue;
    const bucket = new Date(row.bucket);
    points.push({
      bucket,
      avg,
      min: toNumberOrUndefined(row.min_value),
      max: toNumberOrUndefined(row.max_value),
      count: toNumberOrUndefined(row.sample_count) ?? 0,
      badCount: toNumberOrUndefined(row.bad_count) ?? 0,
    });
    spans.push({ bucket, bucketEnd: new Date(row.bucket_end) });
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
    gaps: gapsIn(spans, range),
  };
}

/**
 * The stretches of [start, end) where a channel went quiet: longer than one
 * and a half of its own steps between buckets.
 *
 * The step is the channel's typical spacing (median) — not the bucket width.
 * A probe that samples every 30 minutes, charted in 15-minute buckets, fills
 * every other bucket; that is its rhythm, not an outage. Bucket starts and
 * ends come from the database, which aligned them, so a 23- or 25-hour local
 * day is one step, not a gap.
 */
export function gapsIn(
  buckets: readonly { bucket: Date; bucketEnd: Date }[],
  range: { start: Date; end: Date },
): TimeWindow[] {
  const { start, end } = range;
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (first === undefined || last === undefined) {
    return [{ start, end }];
  }
  const width = first.bucketEnd.getTime() - first.bucket.getTime();
  const spacings: number[] = [];
  for (let index = 1; index < buckets.length; index++) {
    const previous = buckets[index - 1];
    const next = buckets[index];
    if (previous && next) spacings.push(next.bucket.getTime() - previous.bucket.getTime());
  }
  spacings.sort((a, b) => a - b);
  const step = Math.max(width, spacings[Math.floor(spacings.length / 2)] ?? width);
  const quiet = 1.5 * step;

  const gaps: TimeWindow[] = [];
  if (first.bucket.getTime() - start.getTime() >= quiet) {
    gaps.push({ start, end: first.bucket });
  }
  for (let index = 1; index < buckets.length; index++) {
    const previous = buckets[index - 1];
    const next = buckets[index];
    if (previous && next && next.bucket.getTime() - previous.bucket.getTime() > quiet) {
      gaps.push({ start: previous.bucketEnd, end: next.bucket });
    }
  }
  if (end.getTime() - last.bucketEnd.getTime() >= quiet) {
    gaps.push({ start: last.bucketEnd, end });
  }
  return gaps;
}

/**
 * The series SQL and its parameters for a resolved read. Every table, column
 * and expression comes from the fixed tier-policy whitelist and this module
 * (never user input); everything else is bound: $1 interval, $2 sensor,
 * $3 tenant, $4 channels, $5 scan start, $6 end, then $7 zone and $8 window
 * start only where the SQL uses them (an unreferenced parameter has no type
 * Postgres could infer). The window is [scan start, end): a rollup bucket
 * overlapping the start counts, a bucket starting at the end does not.
 *
 * With boundary minutes the rows are the hourly rollup's hours that lie
 * inside one local bucket plus the minute rollup's rows of the hours that
 * straddle a local boundary — exact for a +05:30 or +05:45 zone. Minute rows
 * are exact, so they are taken from the window's own start, not the widened
 * scan start. Both rollups store the same partial columns, so one weighted
 * re-bucketing serves both.
 */
function seriesQuery(
  read: { plan: MetricReadPlan; source: MetricSource; minuteSource: MetricSource | null },
  values: {
    sensorId: string;
    tenantId: string;
    channelIds: string[];
    windowStart: Date;
    end: Date;
    zone: string;
  },
): { sql: string; params: unknown[] } {
  const { plan, source, minuteSource } = read;
  const bucketing = bucketingFor(plan);
  // Parameters are numbered as they are bound, so only values the SQL uses
  // are sent (an unreferenced parameter has no type Postgres could infer).
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const interval = bind(plan.interval);
  const sensor = bind(values.sensorId);
  const tenant = bind(values.tenantId);
  const channels = bind(values.channelIds);
  const scanFrom = bind(scanStart(plan, source));
  const end = bind(values.end);
  const zone = bucketing === 'utc' ? '' : bind(values.zone);
  const windowStart =
    bucketing === 'origin' || (plan.boundaryMinutes && minuteSource !== null)
      ? bind(values.windowStart)
      : '';
  const refs = { interval, zone, windowStart };
  const agg = bucketAggregateExpressions(source);
  const filters = (alias: string, column: string, from: string): string =>
    `${alias}.sensor_id = ${sensor} AND ${alias}.tenant_id = ${tenant} AND ${alias}.channel_id = ANY(${channels})
       AND ${alias}.${column} >= ${from} AND ${alias}.${column} < ${end}`;

  let from: string;
  let time: string;
  let where: string;
  if (plan.boundaryMinutes && minuteSource !== null) {
    const bucketOf = (expr: string): string =>
      seriesBucketExpressions(bucketing, expr, refs).bucket;
    const straddles = (hourStart: string): string =>
      `${bucketOf(hourStart)} <> ${bucketOf(`${hourStart} + interval '59 minutes'`)}`;
    const columns = 'channel_id, bucket, avg_value, min_value, max_value, sample_count, bad_count';
    from = `(
        SELECT ${columns} FROM ${source.table} h
         WHERE ${filters('h', 'bucket', scanFrom)} AND NOT (${straddles('h.bucket')})
        UNION ALL
        SELECT ${columns} FROM ${minuteSource.table} m
         WHERE ${filters('m', 'bucket', windowStart)}
           AND ${straddles("time_bucket('1 hour', m.bucket)")}
      ) s`;
    time = 's.bucket';
    where = '';
  } else {
    from = `${source.table} s`;
    time = `s.${source.timeColumn}`;
    where = `WHERE ${filters('s', source.timeColumn, scanFrom)}`;
  }
  const { bucket, bucketEnd } = seriesBucketExpressions(bucketing, time, refs);
  const sql = `SELECT q.*, ${bucketEnd('q.bucket')} AS bucket_end
            FROM (
              SELECT s.channel_id AS channel_id,
                     ${bucket} AS bucket,
                     ${agg.avg} AS avg_value,
                     ${agg.min} AS min_value,
                     ${agg.max} AS max_value,
                     ${agg.count} AS sample_count,
                     ${agg.badCount} AS bad_count
                FROM ${from}
               ${where}
               -- Positional: a rollup's own \`bucket\` column would win over the
               -- alias, and the rows would not be re-bucketed at all.
               GROUP BY 1, 2
            ) q
           ORDER BY q.bucket ASC`;
  return { sql, params };
}
