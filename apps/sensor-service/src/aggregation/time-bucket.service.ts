import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Granularity tiers for time-bucketed queries.
 * Mirrors the continuous-aggregate views created by
 * 1735900001000-CreateContinuousAggregates.ts.
 */
export enum TimeBucketGranularity {
  RAW    = 'sensor_metrics',
  MIN_1  = 'metrics_1min',
  HOUR_1 = 'metrics_1hour',
  DAY_1  = 'metrics_1day',
}

/**
 * Result row from a time-bucketed aggregate query.
 */
export interface TimeBucketRow {
  bucket: Date;
  sensorId: string;
  channelId: string;
  avgValue: number;
  minValue: number;
  maxValue: number;
  sampleCount: number;
  qualityPct: number;
}

/**
 * Time Bucket Service
 *
 * Centralised query router that selects the appropriate TimescaleDB
 * continuous-aggregate tier based on the requested time range and
 * desired resolution, preventing clients from accidentally scanning
 * the raw hypertable for multi-day/week queries.
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class TimeBucketService {
  private readonly logger = new Logger(TimeBucketService.name);

  /** Boundaries for automatic tier selection */
  private static readonly TIER_THRESHOLDS = {
    /** Use raw data for spans up to 2 hours */
    RAW_MAX_MS:    2  * 60 * 60 * 1000,
    /** Use 1-min aggregates for spans up to 7 days */
    MIN1_MAX_MS:   7  * 24 * 60 * 60 * 1000,
    /** Use 1-hour aggregates for spans up to 90 days */
    HOUR1_MAX_MS:  90 * 24 * 60 * 60 * 1000,
    // Beyond 90 days → metrics_1day
  };

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Select the optimal aggregate tier for the given time range.
   */
  selectTier(startTime: Date, endTime: Date): TimeBucketGranularity {
    const spanMs = endTime.getTime() - startTime.getTime();
    const t = TimeBucketService.TIER_THRESHOLDS;

    if (spanMs <= t.RAW_MAX_MS)   return TimeBucketGranularity.RAW;
    if (spanMs <= t.MIN1_MAX_MS)  return TimeBucketGranularity.MIN_1;
    if (spanMs <= t.HOUR1_MAX_MS) return TimeBucketGranularity.HOUR_1;
    return TimeBucketGranularity.DAY_1;
  }

  /**
   * Query time-bucketed metrics for a sensor/channel combination,
   * automatically selecting the appropriate aggregate tier.
   */
  async query(options: {
    tenantId: string;
    sensorId?: string;
    channelId?: string;
    tankId?: string;
    startTime: Date;
    endTime: Date;
    limit?: number;
  }): Promise<TimeBucketRow[]> {
    const { tenantId, sensorId, channelId, tankId, startTime, endTime, limit = 1000 } = options;
    const tier = this.selectTier(startTime, endTime);

    this.logger.debug(
      `TimeBucket query: tier=${tier}, range=${startTime.toISOString()}—${endTime.toISOString()}`,
    );

    // Validate tier against known enum values before interpolation
    const validTiers: string[] = Object.values(TimeBucketGranularity);
    if (!validTiers.includes(tier)) {
      throw new Error(`Invalid tier: ${tier}`);
    }

    if (tier === TimeBucketGranularity.RAW) {
      return this.queryRaw(tenantId, sensorId, channelId, tankId, startTime, endTime, limit);
    }

    return this.queryAggregate(tier, tenantId, sensorId, channelId, tankId, startTime, endTime, limit);
  }

  private async queryRaw(
    tenantId: string,
    sensorId: string | undefined,
    channelId: string | undefined,
    tankId: string | undefined,
    startTime: Date,
    endTime: Date,
    limit: number,
  ): Promise<TimeBucketRow[]> {
    const params: unknown[] = [tenantId, startTime, endTime];
    let sql = `
      SELECT
        time AS bucket,
        sensor_id AS "sensorId",
        channel_id AS "channelId",
        value AS "avgValue",
        value AS "minValue",
        value AS "maxValue",
        1 AS "sampleCount",
        CASE WHEN quality_code >= 192 THEN 100.0 ELSE 0.0 END AS "qualityPct"
      FROM sensor_metrics
      WHERE tenant_id = $1 AND time >= $2 AND time <= $3
    `;
    let p = 4;
    if (sensorId)  { sql += ` AND sensor_id  = $${p++}`; params.push(sensorId);  }
    if (channelId) { sql += ` AND channel_id = $${p++}`; params.push(channelId); }
    if (tankId)    { sql += ` AND tank_id    = $${p++}`; params.push(tankId);    }
    sql += ` ORDER BY time DESC LIMIT $${p}`;
    params.push(Math.min(Math.max(1, limit), 10000));

    return this.dataSource.query(sql, params) as Promise<TimeBucketRow[]>;
  }

  private async queryAggregate(
    tier: TimeBucketGranularity,
    tenantId: string,
    sensorId: string | undefined,
    channelId: string | undefined,
    tankId: string | undefined,
    startTime: Date,
    endTime: Date,
    limit: number,
  ): Promise<TimeBucketRow[]> {
    const params: unknown[] = [tenantId, startTime, endTime];
    // tier is validated against the enum above
    let sql = `
      SELECT
        bucket,
        sensor_id  AS "sensorId",
        channel_id AS "channelId",
        avg_value  AS "avgValue",
        min_value  AS "minValue",
        max_value  AS "maxValue",
        sample_count AS "sampleCount",
        quality_pct  AS "qualityPct"
      FROM ${tier}
      WHERE tenant_id = $1 AND bucket >= $2 AND bucket <= $3
    `;
    let p = 4;
    if (sensorId)  { sql += ` AND sensor_id  = $${p++}`; params.push(sensorId);  }
    if (channelId) { sql += ` AND channel_id = $${p++}`; params.push(channelId); }
    if (tankId)    { sql += ` AND tank_id    = $${p++}`; params.push(tankId);    }
    sql += ` ORDER BY bucket DESC LIMIT $${p}`;
    params.push(Math.min(Math.max(1, limit), 10000));

    return this.dataSource.query(sql, params) as Promise<TimeBucketRow[]>;
  }
}
