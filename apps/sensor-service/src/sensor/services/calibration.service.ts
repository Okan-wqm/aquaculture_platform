/**
 * Calibration Service Implementation
 * Implements Strategy Pattern for flexible calibration algorithms
 * Follows SOLID principles:
 * - SRP: Only handles calibration logic
 * - OCP: New strategies can be added without modifying this class
 * - DIP: Depends on abstractions (interfaces)
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorReadings } from '../../database/entities/sensor-reading.entity';
import { canonicalReadingKey } from '../../database/entities/sensor-reading-key';
import {
  ICalibrationService,
  ICalibrationStrategy,
  CalibrationConfig,
  CalibrationResult,
  CALIBRATION_SERVICE,
} from '../interfaces/calibration-strategy.interface';

/**
 * LRU Cache implementation with TTL
 */
class LRUCache<K, V> {
  private cache = new Map<K, { value: V; expiry: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Linear Calibration Strategy
 * Applies: calibrated = (raw * multiplier) + offset
 */
@Injectable()
export class LinearCalibrationStrategy implements ICalibrationStrategy {
  getName(): string {
    return 'linear';
  }

  canHandle(config: CalibrationConfig): boolean {
    return (
      config.enabled &&
      !config.polynomial?.length &&
      !config.lookupTable?.length &&
      !config.expression
    );
  }

  calibrate(rawValue: number, config: CalibrationConfig): CalibrationResult {
    if (!config.enabled) {
      return {
        originalValue: rawValue,
        calibratedValue: rawValue,
        method: 'none',
      };
    }

    const multiplier = config.multiplier ?? 1;
    const offset = config.offset ?? 0;
    const calibratedValue = rawValue * multiplier + offset;

    return {
      originalValue: rawValue,
      calibratedValue,
      method: 'linear',
      confidence: 1.0,
    };
  }
}

/**
 * Polynomial Calibration Strategy
 * Applies: calibrated = a0 + a1*x + a2*x^2 + a3*x^3 + ...
 */
@Injectable()
export class PolynomialCalibrationStrategy implements ICalibrationStrategy {
  getName(): string {
    return 'polynomial';
  }

  canHandle(config: CalibrationConfig): boolean {
    return config.enabled && !!config.polynomial?.length;
  }

  calibrate(rawValue: number, config: CalibrationConfig): CalibrationResult {
    if (!config.enabled || !config.polynomial?.length) {
      return {
        originalValue: rawValue,
        calibratedValue: rawValue,
        method: 'none',
      };
    }

    const calibratedValue = config.polynomial.reduce(
      (sum, coef, power) => sum + coef * Math.pow(rawValue, power),
      0,
    );

    return {
      originalValue: rawValue,
      calibratedValue,
      method: 'polynomial',
      confidence: 1.0,
    };
  }
}

/**
 * Lookup Table Calibration Strategy
 * Uses linear interpolation between known points
 */
@Injectable()
export class LookupTableCalibrationStrategy implements ICalibrationStrategy {
  getName(): string {
    return 'lookup';
  }

  canHandle(config: CalibrationConfig): boolean {
    return config.enabled && !!config.lookupTable?.length && config.lookupTable.length >= 2;
  }

  calibrate(rawValue: number, config: CalibrationConfig): CalibrationResult {
    if (!config.enabled || !config.lookupTable?.length) {
      return {
        originalValue: rawValue,
        calibratedValue: rawValue,
        method: 'none',
      };
    }

    // MEDIUM-004: Sort is done once when the table is first used (ascending raw values).
    // The config object is mutated in-place so subsequent calls reuse the sorted array.
    const configWithSortFlag = config as CalibrationConfig & { _sorted?: boolean };
    if (!configWithSortFlag._sorted) {
      config.lookupTable.sort((a, b) => a.raw - b.raw);
      configWithSortFlag._sorted = true;
    }
    const table = config.lookupTable;

    // Ensure table has at least 2 entries for interpolation
    if (table.length < 2) {
      return {
        originalValue: rawValue,
        calibratedValue: rawValue,
        method: 'none',
      };
    }

    const firstEntry = table[0]!;
    const lastEntry = table[table.length - 1]!;

    // Handle out of range values
    if (rawValue <= firstEntry.raw) {
      return {
        originalValue: rawValue,
        calibratedValue: firstEntry.calibrated,
        method: 'lookup',
        confidence: rawValue === firstEntry.raw ? 1.0 : 0.8,
      };
    }

    if (rawValue >= lastEntry.raw) {
      return {
        originalValue: rawValue,
        calibratedValue: lastEntry.calibrated,
        method: 'lookup',
        confidence: rawValue === lastEntry.raw ? 1.0 : 0.8,
      };
    }

    // Find surrounding points and interpolate
    for (let i = 0; i < table.length - 1; i++) {
      const current = table[i]!;
      const next = table[i + 1]!;

      if (rawValue >= current.raw && rawValue <= next.raw) {
        const ratio = (rawValue - current.raw) / (next.raw - current.raw);
        const calibratedValue = current.calibrated + ratio * (next.calibrated - current.calibrated);

        return {
          originalValue: rawValue,
          calibratedValue,
          method: 'lookup',
          confidence: 1.0,
        };
      }
    }

    // Fallback (should not reach here)
    return {
      originalValue: rawValue,
      calibratedValue: rawValue,
      method: 'none',
    };
  }
}

/**
 * Calibration Service
 * Orchestrates calibration strategies with caching
 */
@Injectable()
export class CalibrationService implements ICalibrationService {
  private readonly logger = new Logger(CalibrationService.name);
  private readonly strategies: ICalibrationStrategy[] = [];
  private readonly channelCache: LRUCache<string, SensorDataChannel[]>;

  // Configuration
  private static readonly CACHE_MAX_SIZE = 1000;
  private static readonly CACHE_TTL_MS = 60000; // 1 minute

  constructor(
    @Optional()
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel> | null,
  ) {
    this.channelCache = new LRUCache(
      CalibrationService.CACHE_MAX_SIZE,
      CalibrationService.CACHE_TTL_MS,
    );

    // Register default strategies
    this.registerStrategy(new LinearCalibrationStrategy());
    this.registerStrategy(new PolynomialCalibrationStrategy());
    this.registerStrategy(new LookupTableCalibrationStrategy());
  }

  registerStrategy(strategy: ICalibrationStrategy): void {
    this.strategies.push(strategy);
    this.logger.debug(`Registered calibration strategy: ${strategy.getName()}`);
  }

  async applyCalibration(
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

      // SENSOR-MEDIUM-067: reconcile the snake_case channelKey with the
      // camelCase SensorReadings field via the canonical codec, so a multi-word
      // metric (dissolved_oxygen -> dissolvedOxygen) actually calibrates instead
      // of silently no-op'ing on an always-undefined lookup.
      const key = canonicalReadingKey(channel.channelKey) as keyof SensorReadings;
      const rawValue = transformed[key];

      if (rawValue !== undefined && typeof rawValue === 'number') {
        const config: CalibrationConfig = {
          enabled: true,
          multiplier: Number(channel.calibrationMultiplier) || 1,
          offset: Number(channel.calibrationOffset) || 0,
          polynomial: channel.calibrationPolynomial?.coefficients,
        };

        const result = this.calibrateValue(rawValue, config);
        (transformed as Record<string, number | undefined>)[key] = result.calibratedValue;

        this.logger.debug(
          `Calibrated ${channel.channelKey}: ${rawValue} -> ${result.calibratedValue} ` +
            `(method: ${result.method})`,
        );
      }
    }

    return transformed;
  }

  calibrateValue(rawValue: number, config: CalibrationConfig): CalibrationResult {
    if (!config.enabled) {
      return {
        originalValue: rawValue,
        calibratedValue: rawValue,
        method: 'none',
      };
    }

    // Find appropriate strategy
    for (const strategy of this.strategies) {
      if (strategy.canHandle(config)) {
        return strategy.calibrate(rawValue, config);
      }
    }

    // Default to linear if no strategy matches
    const linearStrategy = this.strategies.find((s) => s.getName() === 'linear');
    if (linearStrategy) {
      return linearStrategy.calibrate(rawValue, config);
    }

    // Fallback: no calibration
    return {
      originalValue: rawValue,
      calibratedValue: rawValue,
      method: 'none',
    };
  }

  clearCache(sensorId?: string): void {
    if (sensorId) {
      this.channelCache.delete(sensorId);
    } else {
      this.channelCache.clear();
    }
  }

  /**
   * Directly warm the channel cache for a sensor with pre-fetched channels.
   * Called by SensorIngestionService.prefetchCalibrationConfigs() to avoid
   * N sequential DB queries during batch prefetch (MEDIUM-003).
   */
  warmChannelCache(sensorId: string, channels: SensorDataChannel[]): void {
    this.channelCache.set(sensorId, channels);
  }

  private async getChannelsForSensor(sensorId: string): Promise<SensorDataChannel[]> {
    if (!this.channelRepository) {
      return [];
    }

    // Check cache first
    const cached = this.channelCache.get(sensorId);
    if (cached) {
      return cached;
    }

    try {
      const channels = await this.channelRepository.find({
        where: { sensorId, isEnabled: true },
      });

      this.channelCache.set(sensorId, channels);
      return channels;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch channels for sensor ${sensorId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.channelCache.size,
      maxSize: CalibrationService.CACHE_MAX_SIZE,
    };
  }
}
