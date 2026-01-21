import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AggregatedMetric } from '../../database/entities/sensor-metric.entity';

/**
 * Data source types for time-series queries
 */
export enum DataSourceType {
  RAW = 'sensor_metrics',
  MINUTE = 'metrics_1min',
  HOUR = 'metrics_1hour',
  DAY = 'metrics_1day',
}

/**
 * Query options for metric retrieval
 */
export interface MetricQueryOptions {
  sensorId?: string;
  channelId?: string;
  tenantId: string;
  tankId?: string;
  startTime: Date;
  endTime: Date;
  limit?: number;
  offset?: number;
}

/**
 * Current reading for a channel
 */
export interface CurrentReading {
  sensorId: string;
  channelId: string;
  channelKey: string;
  displayName: string;
  value: number;
  rawValue: number;
  unit?: string;
  unitSymbol?: string;
  qualityCode: number;
  lastReadingAt: Date;
  alertStatus: 'normal' | 'warning' | 'critical';
}

/**
 * Metric Query Service
 *
 * Provides optimized queries for sensor metrics by automatically
 * selecting the best data source based on time range:
 * - Last 1 hour: Raw data (sensor_metrics)
 * - Last 24 hours: 1-minute aggregates (metrics_1min)
 * - Last 30 days: 1-hour aggregates (metrics_1hour)
 * - 30+ days: Daily aggregates (metrics_1day)
 */
@Injectable()
export class MetricQueryService {
  private readonly logger = new Logger(MetricQueryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get optimal data source based on time range
   */
  getOptimalDataSource(startTime: Date, endTime: Date): DataSourceType {
    const hours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);

    if (hours <= 1) {
      return DataSourceType.RAW;
    }
    if (hours <= 24) {
      return DataSourceType.MINUTE;
    }
    if (hours <= 720) {
      // 30 days
      return DataSourceType.HOUR;
    }
    return DataSourceType.DAY;
  }

  /**
   * Get metrics with automatic data source selection
   */
  async getMetrics(options: MetricQueryOptions): Promise<AggregatedMetric[]> {
    const dataSource = this.getOptimalDataSource(options.startTime, options.endTime);

    this.logger.debug(
      `Querying ${dataSource} for range: ${options.startTime.toISOString()} - ${options.endTime.toISOString()}`,
    );

    if (dataSource === DataSourceType.RAW) {
      return this.queryRawMetrics(options);
    }

    return this.queryAggregatedMetrics(options, dataSource);
  }

  /**
   * Query raw metrics from sensor_metrics table
   */
  private async queryRawMetrics(options: MetricQueryOptions): Promise<AggregatedMetric[]> {
    const { sensorId, channelId, tenantId, tankId, startTime, endTime, limit = 1000 } = options;

    let query = `
      SELECT
        time AS bucket,
        sensor_id AS "sensorId",
        channel_id AS "channelId",
        value AS "avgValue",
        value AS "minValue",
        value AS "maxValue",
        NULL AS "stddevValue",
        value AS "firstValue",
        value AS "lastValue",
        1 AS "sampleCount",
        CASE WHEN quality_code >= 192 THEN 1 ELSE 0 END AS "goodCount",
        CASE WHEN quality_code >= 192 THEN 100.0 ELSE 0.0 END AS "qualityPct"
      FROM sensor_metrics
      WHERE tenant_id = $1
        AND time >= $2
        AND time <= $3
    `;

    const params: any[] = [tenantId, startTime, endTime];
    let paramIndex = 4;

    if (sensorId) {
      query += ` AND sensor_id = $${paramIndex}`;
      params.push(sensorId);
      paramIndex++;
    }

    if (channelId) {
      query += ` AND channel_id = $${paramIndex}`;
      params.push(channelId);
      paramIndex++;
    }

    if (tankId) {
      query += ` AND tank_id = $${paramIndex}`;
      params.push(tankId);
      paramIndex++;
    }

    query += ` ORDER BY time DESC LIMIT ${limit}`;

    const results = await this.dataSource.query(query, params);
    return results;
  }

  /**
   * Query aggregated metrics from continuous aggregates
   */
  private async queryAggregatedMetrics(
    options: MetricQueryOptions,
    dataSource: DataSourceType,
  ): Promise<AggregatedMetric[]> {
    const { sensorId, channelId, tenantId, tankId, startTime, endTime, limit = 1000 } = options;

    let query = `
      SELECT
        bucket,
        sensor_id AS "sensorId",
        channel_id AS "channelId",
        avg_value AS "avgValue",
        min_value AS "minValue",
        max_value AS "maxValue",
        stddev_value AS "stddevValue",
        first_value AS "firstValue",
        last_value AS "lastValue",
        sample_count AS "sampleCount",
        good_count AS "goodCount",
        quality_pct AS "qualityPct"
      FROM ${dataSource}
      WHERE tenant_id = $1
        AND bucket >= $2
        AND bucket <= $3
    `;

    const params: any[] = [tenantId, startTime, endTime];
    let paramIndex = 4;

    if (sensorId) {
      query += ` AND sensor_id = $${paramIndex}`;
      params.push(sensorId);
      paramIndex++;
    }

    if (channelId) {
      query += ` AND channel_id = $${paramIndex}`;
      params.push(channelId);
      paramIndex++;
    }

    if (tankId) {
      query += ` AND tank_id = $${paramIndex}`;
      params.push(tankId);
      paramIndex++;
    }

    query += ` ORDER BY bucket DESC LIMIT ${limit}`;

    const results = await this.dataSource.query(query, params);
    return results;
  }

  /**
   * Get current readings for a sensor
   */
  async getCurrentReadings(sensorId: string, tenantId: string): Promise<CurrentReading[]> {
    const query = `
      SELECT DISTINCT ON (m.channel_id)
        m.sensor_id AS "sensorId",
        m.channel_id AS "channelId",
        c.channel_key AS "channelKey",
        c.display_label AS "displayName",
        m.value,
        m.raw_value AS "rawValue",
        c.unit,
        c.unit_symbol AS "unitSymbol",
        m.quality_code AS "qualityCode",
        m.time AS "lastReadingAt",
        CASE
          WHEN m.value < (c.alert_thresholds->>'criticalLow')::FLOAT THEN 'critical'
          WHEN m.value > (c.alert_thresholds->>'criticalHigh')::FLOAT THEN 'critical'
          WHEN m.value < (c.alert_thresholds->>'warningLow')::FLOAT THEN 'warning'
          WHEN m.value > (c.alert_thresholds->>'warningHigh')::FLOAT THEN 'warning'
          ELSE 'normal'
        END AS "alertStatus"
      FROM sensor_metrics m
      JOIN sensor_data_channels c ON c.id = m.channel_id
      WHERE m.sensor_id = $1
        AND m.tenant_id = $2
        AND m.time > NOW() - INTERVAL '10 minutes'
      ORDER BY m.channel_id, m.time DESC
    `;

    const results = await this.dataSource.query(query, [sensorId, tenantId]);
    return results;
  }

  /**
   * Get current readings for a tank (all sensors)
   */
  async getTankCurrentReadings(tankId: string, tenantId: string): Promise<CurrentReading[]> {
    const query = `
      SELECT DISTINCT ON (m.sensor_id, m.channel_id)
        m.sensor_id AS "sensorId",
        m.channel_id AS "channelId",
        c.channel_key AS "channelKey",
        c.display_label AS "displayName",
        m.value,
        m.raw_value AS "rawValue",
        c.unit,
        c.unit_symbol AS "unitSymbol",
        m.quality_code AS "qualityCode",
        m.time AS "lastReadingAt",
        CASE
          WHEN m.value < (c.alert_thresholds->>'criticalLow')::FLOAT THEN 'critical'
          WHEN m.value > (c.alert_thresholds->>'criticalHigh')::FLOAT THEN 'critical'
          WHEN m.value < (c.alert_thresholds->>'warningLow')::FLOAT THEN 'warning'
          WHEN m.value > (c.alert_thresholds->>'warningHigh')::FLOAT THEN 'warning'
          ELSE 'normal'
        END AS "alertStatus"
      FROM sensor_metrics m
      JOIN sensor_data_channels c ON c.id = m.channel_id
      WHERE m.tank_id = $1
        AND m.tenant_id = $2
        AND m.time > NOW() - INTERVAL '10 minutes'
      ORDER BY m.sensor_id, m.channel_id, m.time DESC
    `;

    const results = await this.dataSource.query(query, [tankId, tenantId]);
    return results;
  }

  /**
   * Get last N readings for a channel
   */
  async getLastReadings(
    channelId: string,
    tenantId: string,
    count = 100,
  ): Promise<{ time: Date; value: number; qualityCode: number }[]> {
    const query = `
      SELECT
        time,
        value,
        quality_code AS "qualityCode"
      FROM sensor_metrics
      WHERE channel_id = $1
        AND tenant_id = $2
      ORDER BY time DESC
      LIMIT $3
    `;

    const results = await this.dataSource.query(query, [channelId, tenantId, count]);
    return results;
  }

  /**
   * Get statistics for a channel over a time period
   */
  async getChannelStatistics(
    channelId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<{
    avg: number;
    min: number;
    max: number;
    stddev: number;
    count: number;
    qualityPct: number;
  }> {
    const dataSource = this.getOptimalDataSource(startTime, endTime);

    let query: string;

    if (dataSource === DataSourceType.RAW) {
      query = `
        SELECT
          AVG(value) AS avg,
          MIN(value) AS min,
          MAX(value) AS max,
          STDDEV(value) AS stddev,
          COUNT(*) AS count,
          (COUNT(*) FILTER (WHERE quality_code >= 192)::FLOAT / NULLIF(COUNT(*), 0) * 100) AS "qualityPct"
        FROM sensor_metrics
        WHERE channel_id = $1
          AND tenant_id = $2
          AND time >= $3
          AND time <= $4
      `;
    } else {
      query = `
        SELECT
          AVG(avg_value) AS avg,
          MIN(min_value) AS min,
          MAX(max_value) AS max,
          SQRT(AVG(POWER(COALESCE(stddev_value, 0), 2))) AS stddev,
          SUM(sample_count) AS count,
          AVG(quality_pct) AS "qualityPct"
        FROM ${dataSource}
        WHERE channel_id = $1
          AND tenant_id = $2
          AND bucket >= $3
          AND bucket <= $4
      `;
    }

    const results = await this.dataSource.query(query, [channelId, tenantId, startTime, endTime]);
    return results[0] || { avg: 0, min: 0, max: 0, stddev: 0, count: 0, qualityPct: 0 };
  }

  /**
   * Get trend data with downsampling for charts
   * Returns approximately maxPoints data points
   */
  async getTrendData(
    channelId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    maxPoints = 500,
  ): Promise<AggregatedMetric[]> {
    const totalSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
    const bucketSeconds = Math.ceil(totalSeconds / maxPoints);

    // Determine bucket size
    let bucketSize: string;
    let dataSource: DataSourceType;

    if (bucketSeconds <= 60) {
      bucketSize = '1 minute';
      dataSource = DataSourceType.MINUTE;
    } else if (bucketSeconds <= 3600) {
      bucketSize = '1 hour';
      dataSource = DataSourceType.HOUR;
    } else {
      bucketSize = '1 day';
      dataSource = DataSourceType.DAY;
    }

    this.logger.debug(
      `Trend query using ${dataSource} with ${bucketSize} buckets for ${maxPoints} max points`,
    );

    const query = `
      SELECT
        bucket,
        sensor_id AS "sensorId",
        channel_id AS "channelId",
        avg_value AS "avgValue",
        min_value AS "minValue",
        max_value AS "maxValue",
        first_value AS "firstValue",
        last_value AS "lastValue",
        sample_count AS "sampleCount",
        quality_pct AS "qualityPct"
      FROM ${dataSource}
      WHERE channel_id = $1
        AND tenant_id = $2
        AND bucket >= $3
        AND bucket <= $4
      ORDER BY bucket ASC
      LIMIT $5
    `;

    const results = await this.dataSource.query(query, [
      channelId,
      tenantId,
      startTime,
      endTime,
      maxPoints,
    ]);

    return results;
  }
}
