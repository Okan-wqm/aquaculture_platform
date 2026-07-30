import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
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
  ) {}

  /**
   * Process a sensor reading.
   * Order: validate raw -> calibrate (channel-level if available, else sensor-level) ->
   *        validate calibrated -> check alerts.
   *
   * @param sensor       - Sensor entity (used for sensor-level calibration fallback and thresholds)
   * @param rawValue     - Raw value from the device
   * @param _timestamp   - Reading timestamp
   * @param channel      - Optional SensorDataChannel: when provided its applyCalibration() is used
   *                       instead of the sensor-level linear calibration, enabling polynomial
   *                       calibration for non-linear sensors (pH probes, dissolved oxygen, etc.)
   */
  processReading(
    sensor: Sensor,
    rawValue: number | string | Record<string, unknown>,
    _timestamp: Date = new Date(),
    channel?: SensorDataChannel,
  ): ProcessingResult {
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

      if (typeof processedValue === 'number') {
        // Step 2: Validate raw value range
        if (sensor.minValue !== undefined && processedValue < sensor.minValue) {
          quality -= 10;
          this.logger.warn(
            `Sensor ${sensor.id}: raw value ${processedValue} below minimum ${sensor.minValue}`,
          );
        }

        if (sensor.maxValue !== undefined && processedValue > sensor.maxValue) {
          quality -= 10;
          this.logger.warn(
            `Sensor ${sensor.id}: raw value ${processedValue} above maximum ${sensor.maxValue}`,
          );
        }

        // Step 3: Apply calibration
        // Channel-level calibration (supports polynomial) takes precedence over sensor-level linear.
        if (channel) {
          // channel.applyCalibration() handles the calibrationEnabled guard internally
          processedValue = channel.applyCalibration(processedValue);
        } else if (sensor.calibrationEnabled) {
          const multiplier = Number(sensor.calibrationMultiplier || 1);
          const offset = Number(sensor.calibrationOffset || 0);
          processedValue = processedValue * multiplier + offset;
        }

        // Step 4: Validate calibrated value range
        const calibrationActive = channel ? channel.calibrationEnabled : sensor.calibrationEnabled;
        if (calibrationActive) {
          if (sensor.minValue !== undefined && processedValue < sensor.minValue) {
            quality -= 10;
          }
          if (sensor.maxValue !== undefined && processedValue > sensor.maxValue) {
            quality -= 10;
          }
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

    return readings.map((r) => this.processReading(sensor, r.value, r.timestamp));
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

    // Calculate sample standard deviation (N-1 for small sample correction)
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
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
   * Interpolate missing values.
   * HIGH-010: Linear interpolation uses a single forward pass (O(N)) instead of
   * nested scans (O(N²)). Null runs are tracked and back-filled when the next
   * non-null value is found.
   */
  interpolateMissing(
    readings: { value: number | null; timestamp: Date }[],
    method: 'linear' | 'forward' | 'backward' = 'linear',
  ): { value: number; timestamp: Date; interpolated: boolean }[] {
    const result: { value: number; timestamp: Date; interpolated: boolean }[] = [];

    if (method === 'forward') {
      // Single forward pass: carry last known value forward
      let lastKnown: number | null = null;
      for (const reading of readings) {
        if (!reading) continue;
        if (reading.value !== null) {
          lastKnown = reading.value;
          result.push({ value: reading.value, timestamp: reading.timestamp, interpolated: false });
        } else if (lastKnown !== null) {
          result.push({ value: lastKnown, timestamp: reading.timestamp, interpolated: true });
        }
      }
      return result;
    }

    if (method === 'backward') {
      // Single backward pass: carry next known value backward
      const temp: { value: number; timestamp: Date; interpolated: boolean }[] = [];
      let nextKnown: number | null = null;
      for (let i = readings.length - 1; i >= 0; i--) {
        const reading = readings[i];
        if (!reading) continue;
        if (reading.value !== null) {
          nextKnown = reading.value;
          temp.push({ value: reading.value, timestamp: reading.timestamp, interpolated: false });
        } else if (nextKnown !== null) {
          temp.push({ value: nextKnown, timestamp: reading.timestamp, interpolated: true });
        }
      }
      return temp.reverse();
    }

    // Linear interpolation — O(N) single forward pass with null-run back-fill
    // Track indices of null entries pending fill and the index of the last known value
    const pendingNullIndices: number[] = [];
    let lastKnownIdx = -1;

    for (let i = 0; i < readings.length; i++) {
      const reading = readings[i];
      if (!reading) continue;

      if (reading.value !== null) {
        // Fill pending nulls between lastKnownIdx and i
        if (pendingNullIndices.length > 0 && lastKnownIdx >= 0) {
          const prev = readings[lastKnownIdx]!;
          const prevValue = prev.value!;
          const prevTime = prev.timestamp.getTime();
          const nextTime = reading.timestamp.getTime();
          const span = nextTime - prevTime;

          for (const nullIdx of pendingNullIndices) {
            const nullReading = readings[nullIdx]!;
            const ratio = span > 0 ? (nullReading.timestamp.getTime() - prevTime) / span : 0;
            result[nullIdx] = {
              value: prevValue + ratio * (reading.value - prevValue),
              timestamp: nullReading.timestamp,
              interpolated: true,
            };
          }
        } else if (pendingNullIndices.length > 0 && lastKnownIdx < 0) {
          // No previous value — use next value as fallback
          for (const nullIdx of pendingNullIndices) {
            const nullReading = readings[nullIdx]!;
            result[nullIdx] = { value: reading.value, timestamp: nullReading.timestamp, interpolated: true };
          }
        }
        pendingNullIndices.length = 0;
        lastKnownIdx = i;
        result[i] = { value: reading.value, timestamp: reading.timestamp, interpolated: false };
      } else {
        pendingNullIndices.push(i);
      }
    }

    // Any trailing nulls with no next value — forward-fill from last known
    if (pendingNullIndices.length > 0 && lastKnownIdx >= 0) {
      const lastValue = readings[lastKnownIdx]!.value!;
      for (const nullIdx of pendingNullIndices) {
        const nullReading = readings[nullIdx]!;
        result[nullIdx] = { value: lastValue, timestamp: nullReading.timestamp, interpolated: true };
      }
    }

    return result.filter(Boolean);
  }

  /**
   * Apply moving average smoothing
   */
  applyMovingAverage(values: number[], windowSize = 5): number[] {
    if (values.length < windowSize) {
      return values;
    }

    const result: number[] = [];
    const halfWindow = Math.floor(windowSize / 2);

    // Use sliding sum to avoid repeated slice allocations
    let windowSum = 0;
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - halfWindow);
      const end = Math.min(values.length, i + halfWindow + 1);
      // Recompute sum for the centered window
      windowSum = 0;
      for (let j = start; j < end; j++) {
        windowSum += values[j] ?? 0;
      }
      result.push(windowSum / (end - start));
    }

    return result;
  }
}
