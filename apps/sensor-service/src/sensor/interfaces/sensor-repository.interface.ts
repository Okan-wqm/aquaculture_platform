/**
 * Sensor Repository Interface
 * Follows Dependency Inversion Principle - services depend on abstraction, not concrete repository
 */

import { Sensor, SensorRole } from '../../database/entities/sensor.entity';
import { SensorReading, SensorReadings } from '../../database/entities/sensor-reading.entity';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';

/**
 * Result type for bulk operations
 */
export interface BulkOperationResult {
  affected: number;
  errors?: Array<{ id: string; error: string }>;
}

/**
 * Sensor reading input for ingestion
 */
export interface SensorReadingInput {
  id: string;
  sensorId: string;
  tenantId: string;
  readings: SensorReadings;
  pondId?: string;
  farmId?: string;
  timestamp: Date;
  source: string;
  quality: number;
}

/**
 * Sensor Repository Interface
 * Abstracts database operations for sensor entities
 */
export interface ISensorRepository {
  /**
   * Find sensor by ID with tenant isolation
   */
  findById(id: string, tenantId: string): Promise<Sensor | null>;

  /**
   * Find sensors by parent ID
   */
  findByParentId(
    parentId: string,
    tenantId: string,
    options?: { activeOnly?: boolean },
  ): Promise<Sensor[]>;

  /**
   * Bulk update last seen timestamps
   * More efficient than individual updates
   */
  bulkUpdateLastSeen(sensorIds: string[]): Promise<BulkOperationResult>;

  /**
   * Update single sensor's last seen timestamp
   */
  updateLastSeen(sensorId: string): Promise<void>;
}

/**
 * Sensor Reading Repository Interface
 */
export interface ISensorReadingRepository {
  /**
   * Insert single reading
   */
  insert(reading: SensorReadingInput): Promise<SensorReading>;

  /**
   * Bulk insert readings - optimized for high throughput
   */
  bulkInsert(readings: SensorReadingInput[]): Promise<number>;

  /**
   * Get latest reading for a sensor
   */
  getLatest(sensorId: string, tenantId: string): Promise<SensorReading | null>;

  /**
   * Get readings in time range
   */
  getInRange(
    sensorId: string,
    tenantId: string,
    startTime: Date,
    endTime: Date,
    limit?: number,
  ): Promise<SensorReading[]>;
}

/**
 * Sensor Data Channel Repository Interface
 */
export interface ISensorChannelRepository {
  /**
   * Find enabled channels for a sensor
   */
  findEnabledBySensorId(sensorId: string): Promise<SensorDataChannel[]>;

  /**
   * Find all channels for multiple sensors (batch operation)
   */
  findBySensorIds(sensorIds: string[]): Promise<Map<string, SensorDataChannel[]>>;
}

/**
 * Repository factory interface for creating repositories
 */
export interface ISensorRepositoryFactory {
  getSensorRepository(): ISensorRepository;
  getReadingRepository(): ISensorReadingRepository;
  getChannelRepository(): ISensorChannelRepository;
}

/**
 * Injection tokens for dependency injection
 */
export const SENSOR_REPOSITORY = Symbol('SENSOR_REPOSITORY');
export const SENSOR_READING_REPOSITORY = Symbol('SENSOR_READING_REPOSITORY');
export const SENSOR_CHANNEL_REPOSITORY = Symbol('SENSOR_CHANNEL_REPOSITORY');
