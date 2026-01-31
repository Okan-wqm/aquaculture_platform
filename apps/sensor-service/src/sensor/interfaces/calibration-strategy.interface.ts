/**
 * Calibration Strategy Interface
 * Follows Open/Closed Principle - new calibration methods can be added without modifying existing code
 * Strategy Pattern for different calibration algorithms
 */

import { SensorReadings } from '../../database/entities/sensor-reading.entity';

/**
 * Calibration configuration
 */
export interface CalibrationConfig {
  /**
   * Whether calibration is enabled
   */
  enabled: boolean;

  /**
   * Linear calibration multiplier (slope)
   */
  multiplier?: number;

  /**
   * Linear calibration offset (intercept)
   */
  offset?: number;

  /**
   * Polynomial coefficients for non-linear calibration
   * [a0, a1, a2, ...] where y = a0 + a1*x + a2*x^2 + ...
   */
  polynomial?: number[];

  /**
   * Lookup table for interpolation-based calibration
   */
  lookupTable?: Array<{ raw: number; calibrated: number }>;

  /**
   * Custom calibration expression (e.g., "x * 1.5 + 0.1")
   */
  expression?: string;
}

/**
 * Calibration result
 */
export interface CalibrationResult {
  originalValue: number;
  calibratedValue: number;
  method: 'linear' | 'polynomial' | 'lookup' | 'expression' | 'none';
  confidence?: number;
}

/**
 * Calibration Strategy Interface
 */
export interface ICalibrationStrategy {
  /**
   * Get the name of this calibration strategy
   */
  getName(): string;

  /**
   * Check if this strategy can handle the given config
   */
  canHandle(config: CalibrationConfig): boolean;

  /**
   * Apply calibration to a single value
   */
  calibrate(rawValue: number, config: CalibrationConfig): CalibrationResult;
}

/**
 * Calibration Service Interface
 * Manages multiple calibration strategies
 */
export interface ICalibrationService {
  /**
   * Register a new calibration strategy
   */
  registerStrategy(strategy: ICalibrationStrategy): void;

  /**
   * Apply calibration to readings using channel configurations
   * @param sensorId The sensor ID to get channel configs for
   * @param readings The raw readings to calibrate
   */
  applyCalibration(
    sensorId: string,
    readings: SensorReadings,
  ): Promise<SensorReadings>;

  /**
   * Calibrate a single value with given config
   */
  calibrateValue(rawValue: number, config: CalibrationConfig): CalibrationResult;

  /**
   * Clear any cached calibration configurations
   */
  clearCache(sensorId?: string): void;
}

/**
 * Injection token
 */
export const CALIBRATION_SERVICE = Symbol('CALIBRATION_SERVICE');
