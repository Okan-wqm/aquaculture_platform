/**
 * Data Quality Service
 * Handles sensor data quality assessment and validation
 * Follows SRP - only responsible for quality calculations
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  QualityCategory,
  QUALITY_GOOD_MIN,
  qualityCategoryOf,
} from '../../database/sensor-quality.authority';
import { SensorReadings } from '../../database/entities/sensor-reading.entity';

/**
 * Quality check configuration for a metric
 */
export interface MetricQualityConfig {
  name: string;
  min: number;
  max: number;
  /**
   * Penalty for out-of-range values (default: 25)
   */
  penalty?: number;
  /**
   * Whether this is a critical metric (default: false)
   * Critical metrics being out of range have higher penalties
   */
  critical?: boolean;
}

/**
 * Quality assessment result for a single reading
 */
export interface QualityAssessment {
  score: number;
  issues: QualityIssue[];
  timestamp: Date;
}

/**
 * Individual quality issue
 */
export interface QualityIssue {
  metric: string;
  type: 'out_of_range' | 'missing' | 'spike' | 'flat' | 'invalid';
  severity: 'warning' | 'error';
  value?: number;
  expectedRange?: { min: number; max: number };
  message: string;
}

/**
 * The score ceiling a set of device-reported OPC-UA quality codes imposes.
 *
 * GOOD leaves the plausibility score untouched. UNCERTAIN caps it below the
 * "looks fine" band so a questionable sample cannot be displayed as healthy.
 * BAD floors it at zero — the device is telling us the value is unusable, and
 * no amount of range-plausibility overrides that.
 */
const UNCERTAIN_SCORE_CEILING = 60;

function deviceTrustCeiling(codes: ReadonlyArray<number | null>): number {
  let ceiling = 100;
  for (const code of codes) {
    // A null code means the row predates per-channel quality or the writer
    // omitted it; the column defaults to GOOD (192), so absence is GOOD.
    const category = qualityCategoryOf(code ?? QUALITY_GOOD_MIN);
    if (category === QualityCategory.BAD) return 0;
    if (category === QualityCategory.UNCERTAIN) {
      ceiling = Math.min(ceiling, UNCERTAIN_SCORE_CEILING);
    }
  }
  return ceiling;
}

/**
 * Default quality configurations for aquaculture metrics
 */
const DEFAULT_QUALITY_CONFIGS: MetricQualityConfig[] = [
  { name: 'temperature', min: -10, max: 50, penalty: 25 },
  { name: 'ph', min: 0, max: 14, penalty: 25, critical: true },
  { name: 'dissolvedOxygen', min: 0, max: 20, penalty: 25, critical: true },
  { name: 'salinity', min: 0, max: 45, penalty: 20 },
  { name: 'ammonia', min: 0, max: 10, penalty: 30, critical: true },
  { name: 'nitrite', min: 0, max: 5, penalty: 25 },
  { name: 'nitrate', min: 0, max: 100, penalty: 20 },
  { name: 'turbidity', min: 0, max: 1000, penalty: 15 },
  { name: 'waterLevel', min: 0, max: 1000, penalty: 15 },
];

/**
 * Data Quality Service
 */
@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name);
  private readonly configs: Map<string, MetricQualityConfig>;

  constructor() {
    this.configs = new Map(DEFAULT_QUALITY_CONFIGS.map((c) => [c.name, c]));
  }

  /**
   * Calculate quality score for sensor readings
   * @returns Score from 0-100 where 100 is perfect quality
   */
  calculateQuality(readings: SensorReadings): number {
    const assessment = this.assess(readings);
    return assessment.score;
  }

  /**
   * Quality score for an as-of projection, which knows something a plain
   * reading does not: what the DEVICE said about each contributing channel.
   *
   * `assess()` scores plausibility — is this value inside the range the
   * parameter can physically take. That is not the same question as "can this
   * value be trusted". A probe that has lost comms, is running on a
   * last-usable value, or reports a config error can still emit a perfectly
   * in-range number, and the plausibility score alone would call that reading
   * 100.
   *
   * The as-of queries already select `quality_code` per channel; the
   * projection used to fetch it and drop it on the floor. Here it becomes a
   * CEILING on the score: a reading can never be scored better than the trust
   * its worst contributing channel reported. Conservative on purpose — this
   * number drives operator-facing displays in a domain where a stale reading
   * presented as fresh costs fish.
   *
   * @param readings Projected parameter values.
   * @param deviceQualityCodes Per-channel OPC-UA `quality_code` values; a
   *   `null` (channel wrote no code) is treated as GOOD, matching the column
   *   default of 192.
   */
  calculateProjectedQuality(
    readings: SensorReadings,
    deviceQualityCodes: ReadonlyArray<number | null>,
  ): number {
    return Math.min(this.calculateQuality(readings), deviceTrustCeiling(deviceQualityCodes));
  }

  /**
   * Perform full quality assessment
   */
  assess(readings: SensorReadings): QualityAssessment {
    const issues: QualityIssue[] = [];
    let score = 100;

    // Check if readings object is empty
    if (!readings || Object.keys(readings).length === 0) {
      issues.push({
        metric: 'readings',
        type: 'missing',
        severity: 'error',
        message: 'No readings provided',
      });
      return { score: 0, issues, timestamp: new Date() };
    }

    // Check each configured metric
    for (const [key, config] of this.configs) {
      const value = readings[key as keyof SensorReadings];

      if (value === undefined || value === null) {
        // Missing value is not necessarily an error (sensor might not have this metric)
        continue;
      }

      if (typeof value !== 'number') {
        issues.push({
          metric: key,
          type: 'invalid',
          severity: 'error',
          message: `Invalid type for ${key}: expected number, got ${typeof value}`,
        });
        score -= config.penalty || 25;
        continue;
      }

      if (Number.isNaN(value) || !Number.isFinite(value)) {
        issues.push({
          metric: key,
          type: 'invalid',
          severity: 'error',
          value,
          message: `Invalid value for ${key}: ${value}`,
        });
        score -= config.penalty || 25;
        continue;
      }

      if (value < config.min || value > config.max) {
        const severity = config.critical ? 'error' : 'warning';
        const penalty = config.critical ? (config.penalty || 25) * 1.5 : config.penalty || 25;

        issues.push({
          metric: key,
          type: 'out_of_range',
          severity,
          value,
          expectedRange: { min: config.min, max: config.max },
          message: `${key} value ${value} is outside expected range [${config.min}, ${config.max}]`,
        });
        score -= penalty;
      }
    }

    // Ensure score stays within bounds
    score = Math.max(0, Math.min(100, score));

    return { score, issues, timestamp: new Date() };
  }

  /**
   * Validate readings and return validation result
   */
  validate(readings: SensorReadings): { valid: boolean; errors: string[] } {
    const assessment = this.assess(readings);
    const errors = assessment.issues.filter((i) => i.severity === 'error').map((i) => i.message);

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check if readings have at least one valid metric
   */
  hasValidMetrics(readings: SensorReadings): boolean {
    if (!readings) return false;

    const metricsToCheck: (keyof SensorReadings)[] = [
      'temperature',
      'ph',
      'dissolvedOxygen',
      'salinity',
      'ammonia',
      'nitrite',
      'nitrate',
      'turbidity',
      'waterLevel',
    ];

    return metricsToCheck.some((key) => {
      const value = readings[key];
      return value !== undefined && typeof value === 'number' && Number.isFinite(value);
    });
  }

  /**
   * Register custom quality configuration
   */
  registerConfig(config: MetricQualityConfig): void {
    this.configs.set(config.name, config);
    this.logger.debug(`Registered quality config for ${config.name}`);
  }

  /**
   * Get current configurations
   */
  getConfigs(): MetricQualityConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Remove readings that fail validation
   * Returns cleaned readings and list of removed metrics
   */
  sanitize(readings: SensorReadings): { sanitized: SensorReadings; removed: string[] } {
    const sanitized: SensorReadings = {};
    const removed: string[] = [];

    for (const [key, value] of Object.entries(readings)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        removed.push(key);
        continue;
      }

      const config = this.configs.get(key);
      if (config && (value < config.min || value > config.max)) {
        // Keep value but flag it
        this.logger.warn(`Value ${key}=${value} is out of expected range`);
      }

      (sanitized as Record<string, number>)[key] = value;
    }

    return { sanitized, removed };
  }
}
