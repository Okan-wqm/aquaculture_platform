/**
 * Reading Mapper Service
 * Implements Strategy Pattern for mapping sensor values to readings structure
 * Follows SOLID principles:
 * - SRP: Only handles value-to-readings mapping
 * - OCP: New sensor types can be added without modifying existing code
 * - DIP: Uses interfaces for extensibility
 */

import { Injectable, Logger } from '@nestjs/common';

import { SensorReadings } from '../../database/entities/sensor-reading.entity';
import { canonicalReadingKey } from '../../database/entities/sensor-reading-key';
import { SensorType } from '../../database/entities/sensor.entity';
import {
  IReadingMapper,
  IReadingMapperRegistry,
  ReadingMappingConfig,
} from '../interfaces/reading-mapper.interface';

/**
 * Base mapper class with common functionality
 */
abstract class BaseReadingMapper implements IReadingMapper {
  abstract canHandle(sensorType: SensorType | string): boolean;
  abstract getReadingKey(): string;

  mapToReadings(value: number, _config: ReadingMappingConfig): SensorReadings {
    const readings: SensorReadings = {};
    // SENSOR-MEDIUM-067: write through the canonical codec so a mapper key can
    // never drift from the key calibration looks up. Idempotent on the camelCase
    // keys the mappers already return — a structural guard, not a behaviour change.
    (readings as Record<string, number>)[canonicalReadingKey(this.getReadingKey())] = value;
    return readings;
  }
}

/**
 * Temperature Sensor Mapper
 */
@Injectable()
export class TemperatureMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.TEMPERATURE || sensorType === 'temperature';
  }

  getReadingKey(): string {
    return 'temperature';
  }
}

/**
 * pH Sensor Mapper
 */
@Injectable()
export class PhMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.PH || sensorType === 'ph';
  }

  getReadingKey(): string {
    return 'ph';
  }
}

/**
 * Dissolved Oxygen Sensor Mapper
 */
@Injectable()
export class DissolvedOxygenMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.DISSOLVED_OXYGEN || sensorType === 'dissolved_oxygen';
  }

  getReadingKey(): string {
    return 'dissolvedOxygen';
  }
}

/**
 * Salinity Sensor Mapper
 */
@Injectable()
export class SalinityMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.SALINITY || sensorType === 'salinity';
  }

  getReadingKey(): string {
    return 'salinity';
  }
}

/**
 * Ammonia Sensor Mapper
 */
@Injectable()
export class AmmoniaMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.AMMONIA || sensorType === 'ammonia';
  }

  getReadingKey(): string {
    return 'ammonia';
  }
}

/**
 * Nitrite Sensor Mapper
 */
@Injectable()
export class NitriteMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.NITRITE || sensorType === 'nitrite';
  }

  getReadingKey(): string {
    return 'nitrite';
  }
}

/**
 * Nitrate Sensor Mapper
 */
@Injectable()
export class NitrateMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.NITRATE || sensorType === 'nitrate';
  }

  getReadingKey(): string {
    return 'nitrate';
  }
}

/**
 * Turbidity Sensor Mapper
 */
@Injectable()
export class TurbidityMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.TURBIDITY || sensorType === 'turbidity';
  }

  getReadingKey(): string {
    return 'turbidity';
  }
}

/**
 * Water Level Sensor Mapper
 */
@Injectable()
export class WaterLevelMapper extends BaseReadingMapper {
  canHandle(sensorType: SensorType | string): boolean {
    return sensorType === SensorType.WATER_LEVEL || sensorType === 'water_level';
  }

  getReadingKey(): string {
    return 'waterLevel';
  }
}

/**
 * Generic/Fallback Mapper
 * Uses dataPath or 'value' as key
 */
@Injectable()
export class GenericMapper implements IReadingMapper {
  canHandle(_sensorType: SensorType | string): boolean {
    return true; // Handles anything as fallback
  }

  getReadingKey(): string {
    return 'value';
  }

  mapToReadings(value: number, config: ReadingMappingConfig): SensorReadings {
    const readings: SensorReadings = {};
    const key = config.customKey || config.dataPath || 'value';
    (readings as Record<string, number>)[key] = value;
    return readings;
  }
}

/**
 * Reading Mapper Registry
 * Manages all reading mappers and provides lookup
 */
@Injectable()
export class ReadingMapperRegistry implements IReadingMapperRegistry {
  private readonly logger = new Logger(ReadingMapperRegistry.name);
  private readonly mappers: IReadingMapper[] = [];
  private readonly fallbackMapper: GenericMapper;

  constructor() {
    this.fallbackMapper = new GenericMapper();

    // Register all standard mappers
    this.register(new TemperatureMapper());
    this.register(new PhMapper());
    this.register(new DissolvedOxygenMapper());
    this.register(new SalinityMapper());
    this.register(new AmmoniaMapper());
    this.register(new NitriteMapper());
    this.register(new NitrateMapper());
    this.register(new TurbidityMapper());
    this.register(new WaterLevelMapper());

    this.logger.log(`Initialized with ${this.mappers.length} sensor type mappers`);
  }

  register(mapper: IReadingMapper): void {
    this.mappers.push(mapper);
  }

  getMapper(sensorType: SensorType | string): IReadingMapper | undefined {
    return this.mappers.find((m) => m.canHandle(sensorType));
  }

  mapToReadings(value: number, config: ReadingMappingConfig): SensorReadings {
    const mapper = this.getMapper(config.sensorType) || this.fallbackMapper;
    return mapper.mapToReadings(value, config);
  }

  getSupportedTypes(): string[] {
    return Object.values(SensorType);
  }

  /**
   * Get mapper statistics for monitoring
   */
  getStats(): { registeredMappers: number; supportedTypes: string[] } {
    return {
      registeredMappers: this.mappers.length,
      supportedTypes: this.getSupportedTypes(),
    };
  }
}
