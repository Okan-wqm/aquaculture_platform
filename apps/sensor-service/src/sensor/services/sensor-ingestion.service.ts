import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import { Repository } from 'typeorm';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorReading, SensorReadings } from '../../database/entities/sensor-reading.entity';
import { Sensor, SensorRole } from '../../database/entities/sensor.entity';

/**
 * Ingest reading data
 */
export interface IngestReadingData {
  sensorId: string;
  tenantId: string;
  readings: SensorReadings;
  pondId?: string;
  farmId?: string;
  timestamp?: Date;
  source?: string;
}

/**
 * Sensor Ingestion Service
 * Handles high-throughput sensor data ingestion
 * Optimized for TimescaleDB and 10K+ readings per second
 */
@Injectable()
export class SensorIngestionService {
  private readonly logger = new Logger(SensorIngestionService.name);

  // Channel cache to avoid repeated DB lookups
  private channelCache = new Map<string, { channels: SensorDataChannel[]; expiry: number }>();
  private readonly CACHE_TTL = 60000; // 1 minute

  constructor(
    @InjectRepository(SensorReading)
    private readonly readingRepository: Repository<SensorReading>,
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @Optional()
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel> | null,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  /**
   * Ingest a single sensor reading
   */
  async ingestReading(data: IngestReadingData): Promise<SensorReading> {
    // Apply calibration transformations if channels are configured
    const transformedReadings = await this.applyCalibration(data.sensorId, data.readings);

    const reading = this.readingRepository.create({
      id: crypto.randomUUID(),
      sensorId: data.sensorId,
      tenantId: data.tenantId,
      readings: transformedReadings,
      pondId: data.pondId,
      farmId: data.farmId,
      timestamp: data.timestamp || new Date(),
      source: data.source || 'http',
      quality: this.calculateDataQuality(transformedReadings),
    });

    const saved = await this.readingRepository.save(reading);

    // Update sensor last seen
    await this.updateSensorLastSeen(data.sensorId);

    // Publish event for real-time processing and alerting
    await this.eventBus.publish({
      eventId: crypto.randomUUID(),
      eventType: 'SensorReading',
      timestamp: saved.timestamp,
      payload: {
        readingId: saved.id,
        sensorId: saved.sensorId,
        tenantId: saved.tenantId,
        readings: saved.readings,
        pondId: saved.pondId,
        farmId: saved.farmId,
      },
      metadata: {
        tenantId: saved.tenantId,
        source: 'sensor-service',
      },
    });

    this.logger.debug(`Ingested reading from sensor ${data.sensorId}`);

    return saved;
  }

  /**
   * Ingest multiple sensor readings in batch
   * Optimized for high-throughput scenarios
   */
  async ingestBatch(readings: IngestReadingData[]): Promise<number> {
    if (readings.length === 0) {
      return 0;
    }

    const entities = readings.map((data) =>
      this.readingRepository.create({
        id: crypto.randomUUID(),
        sensorId: data.sensorId,
        tenantId: data.tenantId,
        readings: data.readings,
        pondId: data.pondId,
        farmId: data.farmId,
        timestamp: data.timestamp || new Date(),
        source: data.source || 'batch',
        quality: this.calculateDataQuality(data.readings),
      }),
    );

    // Use chunked inserts for very large batches
    const chunkSize = 1000;
    let totalInserted = 0;

    for (let i = 0; i < entities.length; i += chunkSize) {
      const chunk = entities.slice(i, i + chunkSize);
      await this.readingRepository.insert(chunk);
      totalInserted += chunk.length;
    }

    // Update last seen for all unique sensors
    const sensorIds = [...new Set(readings.map((r) => r.sensorId))];
    await Promise.all(sensorIds.map((id) => this.updateSensorLastSeen(id)));

    this.logger.log(`Batch ingested ${totalInserted} readings`);

    return totalInserted;
  }

  /**
   * Update sensor's last seen timestamp
   */
  private async updateSensorLastSeen(sensorId: string): Promise<void> {
    try {
      await this.sensorRepository.update(
        { id: sensorId },
        { lastSeenAt: new Date() },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to update lastSeenAt for sensor ${sensorId}`,
        error,
      );
    }
  }

  /**
   * Calculate data quality score based on reading values
   */
  private calculateDataQuality(readings: SensorReadings): number {
    let score = 100;
    const checks: { value?: number; min: number; max: number }[] = [];

    if (readings.temperature !== undefined) {
      checks.push({ value: readings.temperature, min: -10, max: 50 });
    }

    if (readings.ph !== undefined) {
      checks.push({ value: readings.ph, min: 0, max: 14 });
    }

    if (readings.dissolvedOxygen !== undefined) {
      checks.push({ value: readings.dissolvedOxygen, min: 0, max: 20 });
    }

    if (readings.salinity !== undefined) {
      checks.push({ value: readings.salinity, min: 0, max: 45 });
    }

    for (const check of checks) {
      if (
        check.value !== undefined &&
        (check.value < check.min || check.value > check.max)
      ) {
        score -= 25; // Deduct for out-of-range values
      }
    }

    return Math.max(0, score);
  }

  /**
   * Get channels for a sensor with caching
   */
  private async getChannelsForSensor(sensorId: string): Promise<SensorDataChannel[]> {
    if (!this.channelRepository) {
      return [];
    }

    const now = Date.now();
    const cached = this.channelCache.get(sensorId);

    if (cached && cached.expiry > now) {
      return cached.channels;
    }

    try {
      const channels = await this.channelRepository.find({
        where: { sensorId, isEnabled: true },
      });

      this.channelCache.set(sensorId, {
        channels,
        expiry: now + this.CACHE_TTL,
      });

      return channels;
    } catch (error) {
      this.logger.warn(`Failed to fetch channels for sensor ${sensorId}`, error);
      return [];
    }
  }

  /**
   * Apply calibration transformations to readings based on channel configuration
   */
  private async applyCalibration(
    sensorId: string,
    readings: SensorReadings,
  ): Promise<SensorReadings> {
    const channels = await this.getChannelsForSensor(sensorId);

    if (channels.length === 0) {
      return readings;
    }

    const transformed = { ...readings };

    for (const channel of channels) {
      if (!channel.calibrationEnabled) {
        continue;
      }

      // Map channel key to reading property
      const key = channel.channelKey as keyof SensorReadings;
      const rawValue = transformed[key];

      if (rawValue !== undefined && typeof rawValue === 'number') {
        // Apply linear calibration: calibrated = (raw * multiplier) + offset
        const multiplier = Number(channel.calibrationMultiplier) || 1;
        const offset = Number(channel.calibrationOffset) || 0;
        const calibratedValue = (rawValue * multiplier) + offset;

        // Update the reading with calibrated value
        (transformed as any)[key] = calibratedValue;

        this.logger.debug(
          `Calibrated ${channel.channelKey}: ${rawValue} -> ${calibratedValue} ` +
          `(×${multiplier} +${offset})`,
        );
      }
    }

    return transformed;
  }

  /**
   * Clear channel cache for a sensor (call when channels are updated)
   */
  clearChannelCache(sensorId?: string): void {
    if (sensorId) {
      this.channelCache.delete(sensorId);
    } else {
      this.channelCache.clear();
    }
  }

  // ==================== Parent-Child Routing ====================

  // Cache for child sensors lookup
  private childSensorCache = new Map<string, { children: Sensor[]; expiry: number }>();
  private readonly CHILD_CACHE_TTL = 60000; // 1 minute

  /**
   * Ingest a parent device reading and route values to child sensors
   * This is used when a multi-parameter device sends data containing multiple values
   */
  async ingestParentReading(
    parentId: string,
    tenantId: string,
    payload: Record<string, unknown>,
    timestamp?: Date,
    source?: string,
  ): Promise<{ childReadings: SensorReading[]; errors: string[] }> {
    const errors: string[] = [];
    const childReadings: SensorReading[] = [];

    // Get child sensors for this parent
    const children = await this.getChildSensorsForParent(parentId, tenantId);

    if (children.length === 0) {
      this.logger.warn(`No child sensors found for parent ${parentId}`);
      return { childReadings, errors: ['No child sensors configured'] };
    }

    // Process each child sensor
    for (const child of children) {
      try {
        // Extract value from payload using dataPath
        const value = this.extractValueFromPayload(payload, child.dataPath);

        if (value === undefined) {
          this.logger.debug(`No value found for dataPath ${child.dataPath} in payload`);
          continue;
        }

        // Build readings object based on sensor type
        const readings: SensorReadings = this.buildReadingsForChild(child, value);

        // Ingest the reading for this child sensor
        const reading = await this.ingestReading({
          sensorId: child.id,
          tenantId,
          readings,
          pondId: child.pondId,
          farmId: child.farmId,
          timestamp: timestamp || new Date(),
          source: source || 'parent-routing',
        });

        childReadings.push(reading);
      } catch (error) {
        const errorMsg = `Failed to process child sensor ${child.id} (${child.dataPath}): ${(error as Error).message}`;
        this.logger.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    this.logger.log(
      `Routed parent ${parentId} reading to ${childReadings.length}/${children.length} children`
    );

    // Publish parent routing event
    await this.eventBus.publish({
      eventId: crypto.randomUUID(),
      eventType: 'ParentReadingRouted',
      timestamp: timestamp || new Date(),
      payload: {
        parentId,
        tenantId,
        childCount: children.length,
        processedCount: childReadings.length,
        errorCount: errors.length,
      },
      metadata: {
        tenantId,
        source: 'sensor-service',
      },
    });

    return { childReadings, errors };
  }

  /**
   * Get child sensors for a parent device with caching
   */
  private async getChildSensorsForParent(parentId: string, tenantId: string): Promise<Sensor[]> {
    const cacheKey = `${parentId}:${tenantId}`;
    const now = Date.now();
    const cached = this.childSensorCache.get(cacheKey);

    if (cached && cached.expiry > now) {
      return cached.children;
    }

    try {
      const children = await this.sensorRepository.find({
        where: {
          parentId,
          tenantId,
          sensorRole: SensorRole.CHILD,
          isActive: true,
        },
        order: { createdAt: 'ASC' },
      });

      this.childSensorCache.set(cacheKey, {
        children,
        expiry: now + this.CHILD_CACHE_TTL,
      });

      return children;
    } catch (error) {
      this.logger.error(`Failed to fetch child sensors for parent ${parentId}`, error);
      return [];
    }
  }

  /**
   * Extract value from payload using dot notation path
   * Supports nested paths like "sensors.ph" or simple paths like "ph"
   */
  private extractValueFromPayload(
    payload: Record<string, unknown>,
    dataPath?: string,
  ): number | undefined {
    if (!dataPath) return undefined;

    // Support dot notation for nested values
    const parts = dataPath.split('.');
    let value: unknown = payload;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    // Convert to number if possible
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const num = parseFloat(value);
      return isNaN(num) ? undefined : num;
    }

    return undefined;
  }

  /**
   * Build readings object for a child sensor based on its type
   */
  private buildReadingsForChild(child: Sensor, rawValue: number): SensorReadings {
    // Apply calibration if enabled
    let value = rawValue;
    if (child.calibrationEnabled) {
      const multiplier = Number(child.calibrationMultiplier) || 1;
      const offset = Number(child.calibrationOffset) || 0;
      value = (rawValue * multiplier) + offset;

      this.logger.debug(
        `Calibrated ${child.dataPath}: ${rawValue} -> ${value} (×${multiplier} +${offset})`
      );
    }

    // Map sensor type to reading key
    const readings: SensorReadings = {};

    switch (child.type) {
      case 'temperature':
        readings.temperature = value;
        break;
      case 'ph':
        readings.ph = value;
        break;
      case 'dissolved_oxygen':
        readings.dissolvedOxygen = value;
        break;
      case 'salinity':
        readings.salinity = value;
        break;
      case 'ammonia':
        readings.ammonia = value;
        break;
      case 'nitrite':
        readings.nitrite = value;
        break;
      case 'nitrate':
        readings.nitrate = value;
        break;
      case 'turbidity':
        readings.turbidity = value;
        break;
      case 'water_level':
        readings.waterLevel = value;
        break;
      default:
        // For other types, use a generic "value" key or the dataPath
        (readings as any)[child.dataPath || 'value'] = value;
    }

    return readings;
  }

  /**
   * Clear child sensor cache for a parent (call when children are updated)
   */
  clearChildCache(parentId?: string, tenantId?: string): void {
    if (parentId && tenantId) {
      this.childSensorCache.delete(`${parentId}:${tenantId}`);
    } else {
      this.childSensorCache.clear();
    }
  }
}
