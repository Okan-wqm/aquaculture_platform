/**
 * Reading Mapper Interface
 * Follows Open/Closed Principle - new sensor types can be added without modifying existing code
 * Strategy Pattern for mapping sensor values to readings structure
 */

import { SensorReadings } from '../../database/entities/sensor-reading.entity';
import { SensorType } from '../../database/entities/sensor.entity';

/**
 * Mapping configuration for a sensor
 */
export interface ReadingMappingConfig {
  sensorType: SensorType | string;
  dataPath?: string;
  customKey?: string;
}

/**
 * Reading Mapper Interface
 * Maps raw values to the correct SensorReadings structure based on sensor type
 */
export interface IReadingMapper {
  /**
   * Check if this mapper can handle the given sensor type
   */
  canHandle(sensorType: SensorType | string): boolean;

  /**
   * Map a raw value to SensorReadings structure
   */
  mapToReadings(value: number, config: ReadingMappingConfig): SensorReadings;

  /**
   * Get the reading key for this sensor type (e.g., 'temperature', 'ph')
   */
  getReadingKey(): string;
}

/**
 * Reading Mapper Registry Interface
 * Manages multiple reading mappers
 */
export interface IReadingMapperRegistry {
  /**
   * Register a new mapper
   */
  register(mapper: IReadingMapper): void;

  /**
   * Get mapper for a sensor type
   */
  getMapper(sensorType: SensorType | string): IReadingMapper | undefined;

  /**
   * Map value to readings using appropriate mapper
   */
  mapToReadings(value: number, config: ReadingMappingConfig): SensorReadings;

  /**
   * Get all registered sensor types
   */
  getSupportedTypes(): string[];
}

/**
 * Injection token
 */
export const READING_MAPPER_REGISTRY = Symbol('READING_MAPPER_REGISTRY');
