import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, Between, DataSource } from 'typeorm';

import {
  SensorReading,
  SensorReadings,
} from '../../database/entities/sensor-reading.entity';
import {
  AggregatedReadingType,
  AggregatedReadingsResponse,
} from '../dto/aggregated-reading.dto';

/**
 * Aggregation interval options
 */
export type AggregationInterval =
  | '1 minute'
  | '5 minutes'
  | '15 minutes'
  | '1 hour'
  | '4 hours'
  | '1 day'
  | '1 week';

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
 * Determine optimal aggregation interval based on time range
 */
export function getOptimalInterval(startTime: Date, endTime: Date): AggregationInterval {
  const durationMs = endTime.getTime() - startTime.getTime();
  const hours = durationMs / (1000 * 60 * 60);

  // Target: 50-200 data points for optimal visualization
  if (hours <= 1) return '1 minute'; // 60 points max
  if (hours <= 6) return '5 minutes'; // 72 points max
  if (hours <= 24) return '15 minutes'; // 96 points max
  if (hours <= 72) return '1 hour'; // 72 points max
  if (hours <= 168) return '4 hours'; // 42 points max
  if (hours <= 720) return '1 day'; // 30 points max
  return '1 week'; // 52 points max for year
}

/**
 * Sensor Query Service
 * Provides optimized time-series queries using TimescaleDB features
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
    return await this.readingRepository.findOne({
      where: { sensorId, tenantId },
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
    limit = 1000,
  ): Promise<SensorReading[]> {
    // Order by DESC to get most recent readings first
    // Frontend will sort for charts if needed
    return await this.readingRepository.find({
      where: {
        sensorId,
        tenantId,
        timestamp: Between(startTime, endTime),
      },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get aggregated data using TimescaleDB time_bucket
   * This provides efficient time-series aggregation
   */
  async getAggregatedData(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    interval: AggregationInterval,
  ): Promise<AggregatedSensorData[]> {
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
      WHERE "sensorId" = $2
        AND "tenantId" = $3
        AND timestamp BETWEEN $4 AND $5
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const results = await this.dataSource.query(query, [
      interval,
      sensorId,
      tenantId,
      startTime,
      endTime,
    ]);

    return results.map(
      (row: {
        bucket: Date;
        count: string;
        avg_temperature?: string;
        avg_ph?: string;
        avg_dissolved_oxygen?: string;
        avg_salinity?: string;
        avg_ammonia?: string;
        avg_nitrite?: string;
        avg_nitrate?: string;
        min_temperature?: string;
        max_temperature?: string;
      }) => ({
        bucket: row.bucket,
        count: parseInt(row.count, 10),
        averages: {
          temperature: row.avg_temperature
            ? parseFloat(row.avg_temperature)
            : undefined,
          ph: row.avg_ph ? parseFloat(row.avg_ph) : undefined,
          dissolvedOxygen: row.avg_dissolved_oxygen
            ? parseFloat(row.avg_dissolved_oxygen)
            : undefined,
          salinity: row.avg_salinity
            ? parseFloat(row.avg_salinity)
            : undefined,
          ammonia: row.avg_ammonia
            ? parseFloat(row.avg_ammonia)
            : undefined,
          nitrite: row.avg_nitrite
            ? parseFloat(row.avg_nitrite)
            : undefined,
          nitrate: row.avg_nitrate
            ? parseFloat(row.avg_nitrate)
            : undefined,
        },
        minimums: {
          temperature: row.min_temperature
            ? parseFloat(row.min_temperature)
            : undefined,
        },
        maximums: {
          temperature: row.max_temperature
            ? parseFloat(row.max_temperature)
            : undefined,
        },
      }),
    );
  }

  /**
   * Get aggregated readings with full min/max for all metrics
   * Optimized for frontend chart rendering
   */
  async getAggregatedReadings(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    interval?: AggregationInterval,
  ): Promise<AggregatedReadingsResponse> {
    // Auto-select optimal interval if not provided
    const effectiveInterval = interval || getOptimalInterval(startTime, endTime);

    const query = `
      SELECT
        time_bucket($1::interval, timestamp) AS bucket,
        COUNT(*) AS count,
        -- Temperature
        AVG((readings->>'temperature')::numeric) AS avg_temperature,
        MIN((readings->>'temperature')::numeric) AS min_temperature,
        MAX((readings->>'temperature')::numeric) AS max_temperature,
        -- pH
        AVG((readings->>'ph')::numeric) AS avg_ph,
        MIN((readings->>'ph')::numeric) AS min_ph,
        MAX((readings->>'ph')::numeric) AS max_ph,
        -- Dissolved Oxygen
        AVG((readings->>'dissolvedOxygen')::numeric) AS avg_dissolved_oxygen,
        MIN((readings->>'dissolvedOxygen')::numeric) AS min_dissolved_oxygen,
        MAX((readings->>'dissolvedOxygen')::numeric) AS max_dissolved_oxygen,
        -- Salinity
        AVG((readings->>'salinity')::numeric) AS avg_salinity,
        MIN((readings->>'salinity')::numeric) AS min_salinity,
        MAX((readings->>'salinity')::numeric) AS max_salinity,
        -- Ammonia
        AVG((readings->>'ammonia')::numeric) AS avg_ammonia,
        MIN((readings->>'ammonia')::numeric) AS min_ammonia,
        MAX((readings->>'ammonia')::numeric) AS max_ammonia,
        -- Nitrite
        AVG((readings->>'nitrite')::numeric) AS avg_nitrite,
        -- Nitrate
        AVG((readings->>'nitrate')::numeric) AS avg_nitrate,
        -- Turbidity
        AVG((readings->>'turbidity')::numeric) AS avg_turbidity,
        -- Water Level
        AVG((readings->>'waterLevel')::numeric) AS avg_water_level
      FROM sensor_readings
      WHERE "sensorId" = $2
        AND "tenantId" = $3
        AND timestamp >= $4
        AND timestamp <= $5
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const results = await this.dataSource.query(query, [
      effectiveInterval,
      sensorId,
      tenantId,
      startTime,
      endTime,
    ]);

    const data: AggregatedReadingType[] = results.map(
      (row: Record<string, string | null>) => ({
        bucket: new Date(row.bucket as string),
        count: parseInt(row.count || '0', 10),
        avgTemperature: row.avg_temperature ? parseFloat(row.avg_temperature) : undefined,
        minTemperature: row.min_temperature ? parseFloat(row.min_temperature) : undefined,
        maxTemperature: row.max_temperature ? parseFloat(row.max_temperature) : undefined,
        avgPh: row.avg_ph ? parseFloat(row.avg_ph) : undefined,
        minPh: row.min_ph ? parseFloat(row.min_ph) : undefined,
        maxPh: row.max_ph ? parseFloat(row.max_ph) : undefined,
        avgDissolvedOxygen: row.avg_dissolved_oxygen ? parseFloat(row.avg_dissolved_oxygen) : undefined,
        minDissolvedOxygen: row.min_dissolved_oxygen ? parseFloat(row.min_dissolved_oxygen) : undefined,
        maxDissolvedOxygen: row.max_dissolved_oxygen ? parseFloat(row.max_dissolved_oxygen) : undefined,
        avgSalinity: row.avg_salinity ? parseFloat(row.avg_salinity) : undefined,
        minSalinity: row.min_salinity ? parseFloat(row.min_salinity) : undefined,
        maxSalinity: row.max_salinity ? parseFloat(row.max_salinity) : undefined,
        avgAmmonia: row.avg_ammonia ? parseFloat(row.avg_ammonia) : undefined,
        minAmmonia: row.min_ammonia ? parseFloat(row.min_ammonia) : undefined,
        maxAmmonia: row.max_ammonia ? parseFloat(row.max_ammonia) : undefined,
        avgNitrite: row.avg_nitrite ? parseFloat(row.avg_nitrite) : undefined,
        avgNitrate: row.avg_nitrate ? parseFloat(row.avg_nitrate) : undefined,
        avgTurbidity: row.avg_turbidity ? parseFloat(row.avg_turbidity) : undefined,
        avgWaterLevel: row.avg_water_level ? parseFloat(row.avg_water_level) : undefined,
      }),
    );

    // Get sensor name
    let sensorName: string | undefined;
    try {
      const sensor = await this.dataSource.query(
        `SELECT name FROM sensors WHERE id = $1 AND "tenantId" = $2`,
        [sensorId, tenantId],
      );
      sensorName = sensor[0]?.name;
    } catch {
      // Sensor name is optional
    }

    return {
      sensorId,
      sensorName,
      interval: effectiveInterval,
      startTime,
      endTime,
      totalDataPoints: data.length,
      data,
    };
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
    return await this.readingRepository.find({
      where: {
        pondId,
        tenantId,
        timestamp: Between(startTime, endTime),
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
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - days);

    const query = `
      SELECT
        COUNT(*) AS total_readings,
        AVG(quality) AS average_quality,
        MAX(timestamp) AS last_reading
      FROM sensor_readings
      WHERE "sensorId" = $1
        AND "tenantId" = $2
        AND timestamp >= $3
    `;

    const [result] = await this.dataSource.query(query, [
      sensorId,
      tenantId,
      startTime,
    ]);

    const totalReadings = parseInt(result.total_readings || '0', 10);

    return {
      totalReadings,
      averageQuality: result.average_quality
        ? parseFloat(result.average_quality)
        : 0,
      lastReading: result.last_reading || null,
      readingsPerDay: totalReadings / days,
    };
  }
}
