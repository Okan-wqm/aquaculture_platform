import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';

/**
 * Processing result
 */
export interface ProcessingResult {
  success: boolean;
  originalValue: number | string | Record<string, unknown>;
  processedValue: number | string | Record<string, unknown>;
  quality: number;
  alerts?: AlertTrigger[];
  error?: string;
}

/**
 * Alert trigger when threshold is breached
 */
export interface AlertTrigger {
  sensorId: string;
  type: 'warning' | 'critical';
  threshold: 'low' | 'high';
  value: number;
  limit: number;
  message: string;
}

/**
 * Data Processor Service
 * Processes raw sensor data: validation, calibration, unit conversion, threshold checking
 */
@Injectable()
export class DataProcessorService {
  private readonly logger = new Logger(DataProcessorService.name);

  constructor(
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectRepository(SensorReading)
    private readonly readingRepository: Repository<SensorReading>,
  ) {}

  /**
   * Process a sensor reading
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async processReading(
    sensor: Sensor,
    rawValue: number | string | Record<string, unknown>,
    _timestamp: Date = new Date(),
  ): Promise<ProcessingResult> {
    try {
      let processedValue = rawValue;
      let quality = 100;
      const alerts: AlertTrigger[] = [];

      // Step 1: Validate and convert to number if possible
      if (typeof rawValue === 'string') {
        const numValue = parseFloat(rawValue);
        if (!isNaN(numValue)) {
          processedValue = numValue;
        }
      }

      // Step 2: Apply range validation
      if (typeof processedValue === 'number') {
        // Check if value is within expected range
        if (sensor.minValue !== undefined && processedValue < sensor.minValue) {
          quality -= 20;
          this.logger.warn(
            `Sensor ${sensor.id}: value ${processedValue} below minimum ${sensor.minValue}`,
          );
        }

        if (sensor.maxValue !== undefined && processedValue > sensor.maxValue) {
          quality -= 20;
          this.logger.warn(
            `Sensor ${sensor.id}: value ${processedValue} above maximum ${sensor.maxValue}`,
          );
        }

        // Step 3: Apply calibration
        if (sensor.calibrationEnabled) {
          const multiplier = Number(sensor.calibrationMultiplier || 1);
          const offset = Number(sensor.calibrationOffset || 0);
          processedValue = processedValue * multiplier + offset;
        }

        // Step 4: Check alert thresholds
        if (sensor.alertThresholds) {
          const thresholds = sensor.alertThresholds;

          // Warning thresholds
          if (thresholds.warning) {
            if (thresholds.warning.low !== undefined && processedValue < thresholds.warning.low) {
              alerts.push({
                sensorId: sensor.id,
                type: 'warning',
                threshold: 'low',
                value: processedValue,
                limit: thresholds.warning.low,
                message: `${sensor.name} value (${processedValue}${sensor.unit || ''}) is below warning threshold (${thresholds.warning.low}${sensor.unit || ''})`,
              });
            }

            if (thresholds.warning.high !== undefined && processedValue > thresholds.warning.high) {
              alerts.push({
                sensorId: sensor.id,
                type: 'warning',
                threshold: 'high',
                value: processedValue,
                limit: thresholds.warning.high,
                message: `${sensor.name} value (${processedValue}${sensor.unit || ''}) is above warning threshold (${thresholds.warning.high}${sensor.unit || ''})`,
              });
            }
          }

          // Critical thresholds
          if (thresholds.critical) {
            if (thresholds.critical.low !== undefined && processedValue < thresholds.critical.low) {
              alerts.push({
                sensorId: sensor.id,
                type: 'critical',
                threshold: 'low',
                value: processedValue,
                limit: thresholds.critical.low,
                message: `CRITICAL: ${sensor.name} value (${processedValue}${sensor.unit || ''}) is below critical threshold (${thresholds.critical.low}${sensor.unit || ''})`,
              });
              quality -= 10;
            }

            if (thresholds.critical.high !== undefined && processedValue > thresholds.critical.high) {
              alerts.push({
                sensorId: sensor.id,
                type: 'critical',
                threshold: 'high',
                value: processedValue,
                limit: thresholds.critical.high,
                message: `CRITICAL: ${sensor.name} value (${processedValue}${sensor.unit || ''}) is above critical threshold (${thresholds.critical.high}${sensor.unit || ''})`,
              });
              quality -= 10;
            }
          }
        }
      }

      // Ensure quality is between 0 and 100
      quality = Math.max(0, Math.min(100, quality));

      return {
        success: true,
        originalValue: rawValue,
        processedValue,
        quality,
        alerts: alerts.length > 0 ? alerts : undefined,
      };
    } catch (error) {
      this.logger.error(
        `Error processing reading for sensor ${sensor.id}: ${(error as Error).message}`,
      );

      return {
        success: false,
        originalValue: rawValue,
        processedValue: rawValue,
        quality: 0,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Process bulk readings
   */
  async processBulkReadings(
    sensorId: string,
    readings: { value: number | string | Record<string, unknown>; timestamp: Date }[],
  ): Promise<ProcessingResult[]> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId },
    });

    if (!sensor) {
      throw new Error(`Sensor ${sensorId} not found`);
    }

    return Promise.all(
      readings.map((r) => this.processReading(sensor, r.value, r.timestamp)),
    );
  }

  /**
   * Detect anomalies in a series of readings
   */
  detectAnomalies(
    values: number[],
    options: { stdDevThreshold?: number; percentileThreshold?: number } = {},
  ): { anomalyIndices: number[]; stats: { mean: number; stdDev: number } } {
    if (values.length < 3) {
      return { anomalyIndices: [], stats: { mean: 0, stdDev: 0 } };
    }

    const { stdDevThreshold = 3 } = options;

    // Calculate mean
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    // Calculate standard deviation
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(avgSquaredDiff);

    // Find anomalies (values more than threshold standard deviations from mean)
    const anomalyIndices: number[] = [];
    values.forEach((value, index) => {
      if (Math.abs(value - mean) > stdDevThreshold * stdDev) {
        anomalyIndices.push(index);
      }
    });

    return {
      anomalyIndices,
      stats: { mean, stdDev },
    };
  }

  /**
   * Calculate rate of change
   */
  calculateRateOfChange(
    readings: { value: number; timestamp: Date }[],
  ): { ratePerMinute: number; ratePerHour: number } | null {
    if (readings.length < 2) {
      return null;
    }

    // Sort by timestamp
    const sorted = [...readings].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    if (!first || !last) {
      return null;
    }

    const timeDiffMs = last.timestamp.getTime() - first.timestamp.getTime();
    if (timeDiffMs === 0) {
      return null;
    }

    const valueDiff = last.value - first.value;
    const timeDiffMinutes = timeDiffMs / (1000 * 60);
    const timeDiffHours = timeDiffMinutes / 60;

    return {
      ratePerMinute: valueDiff / timeDiffMinutes,
      ratePerHour: valueDiff / timeDiffHours,
    };
  }

  /**
   * Interpolate missing values
   */
  interpolateMissing(
    readings: { value: number | null; timestamp: Date }[],
    method: 'linear' | 'forward' | 'backward' = 'linear',
  ): { value: number; timestamp: Date; interpolated: boolean }[] {
    const result: { value: number; timestamp: Date; interpolated: boolean }[] = [];

    for (let i = 0; i < readings.length; i++) {
      const reading = readings[i];
      if (!reading) continue;

      if (reading.value !== null) {
        result.push({
          value: reading.value,
          timestamp: reading.timestamp,
          interpolated: false,
        });
        continue;
      }

      // Value is null, need to interpolate
      let interpolatedValue: number | null = null;

      switch (method) {
        case 'forward':
          // Use previous value
          for (let j = i - 1; j >= 0; j--) {
            const r = readings[j];
            if (r && r.value !== null) {
              interpolatedValue = r.value;
              break;
            }
          }
          break;

        case 'backward':
          // Use next value
          for (let j = i + 1; j < readings.length; j++) {
            const r = readings[j];
            if (r && r.value !== null) {
              interpolatedValue = r.value;
              break;
            }
          }
          break;

        case 'linear':
        default: {
          // Find previous and next non-null values
          let prevIndex = -1;
          let nextIndex = -1;

          for (let j = i - 1; j >= 0; j--) {
            const r = readings[j];
            if (r && r.value !== null) {
              prevIndex = j;
              break;
            }
          }

          for (let j = i + 1; j < readings.length; j++) {
            const r = readings[j];
            if (r && r.value !== null) {
              nextIndex = j;
              break;
            }
          }

          if (prevIndex >= 0 && nextIndex >= 0) {
            // Linear interpolation
            const prevReading = readings[prevIndex];
            const nextReading = readings[nextIndex];
            if (prevReading && nextReading && prevReading.value !== null && nextReading.value !== null) {
              const prevValue = prevReading.value;
              const nextValue = nextReading.value;
              const prevTime = prevReading.timestamp.getTime();
              const nextTime = nextReading.timestamp.getTime();
              const currentTime = reading.timestamp.getTime();

              const ratio = (currentTime - prevTime) / (nextTime - prevTime);
              interpolatedValue = prevValue + ratio * (nextValue - prevValue);
            }
          } else if (prevIndex >= 0) {
            const prevReading = readings[prevIndex];
            if (prevReading) {
              interpolatedValue = prevReading.value;
            }
          } else if (nextIndex >= 0) {
            const nextReading = readings[nextIndex];
            if (nextReading) {
              interpolatedValue = nextReading.value;
            }
          }
          break;
        }
      }

      if (interpolatedValue !== null) {
        result.push({
          value: interpolatedValue,
          timestamp: reading.timestamp,
          interpolated: true,
        });
      }
    }

    return result;
  }

  /**
   * Apply moving average smoothing
   */
  applyMovingAverage(values: number[], windowSize = 5): number[] {
    if (values.length < windowSize) {
      return values;
    }

    const result: number[] = [];

    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - Math.floor(windowSize / 2));
      const end = Math.min(values.length, start + windowSize);
      const window = values.slice(start, end);
      const avg = window.reduce((a, b) => a + b, 0) / window.length;
      result.push(avg);
    }

    return result;
  }
}
