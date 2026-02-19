import { Injectable, Logger } from '@nestjs/common';

/**
 * Anomaly detection result for a single metric value.
 */
export interface AnomalyResult {
  sensorId: string;
  channelId: string;
  value: number;
  isAnomaly: boolean;
  zScore: number;
  severity: 'none' | 'mild' | 'moderate' | 'severe';
}

/**
 * Running statistics maintained per sensor+channel key for online anomaly detection.
 */
interface RunningStats {
  /** Welford algorithm state */
  count: number;
  mean: number;
  m2: number; // sum of squared differences from the mean
  min: number;
  max: number;
}

/**
 * Anomaly Detector Service
 *
 * Performs lightweight, single-pass online anomaly detection using Welford's
 * algorithm for incremental mean/variance computation.  This avoids the four
 * full-array passes described in HIGH-010 / CRITICAL-005.
 *
 * Severity classification (Z-score based):
 *   |z| < 2.5  → none
 *   |z| < 3.5  → mild
 *   |z| < 5.0  → moderate
 *   |z| >= 5.0 → severe
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class AnomalyDetectorService {
  private readonly logger = new Logger(AnomalyDetectorService.name);

  /** Per sensor+channel running statistics */
  private readonly stats = new Map<string, RunningStats>();

  /** Minimum samples required before declaring anomalies */
  private static readonly MIN_SAMPLES = 30;

  /**
   * Update the running statistics for a sensor+channel and return an anomaly
   * assessment for the new value.  Safe to call on every ingested metric.
   */
  detect(sensorId: string, channelId: string, value: number): AnomalyResult {
    const key = `${sensorId}:${channelId}`;
    const s = this.getOrCreateStats(key);

    // Welford online algorithm — O(1) per call
    s.count++;
    const delta  = value - s.mean;
    s.mean += delta / s.count;
    const delta2 = value - s.mean;
    s.m2   += delta * delta2;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;

    if (s.count < AnomalyDetectorService.MIN_SAMPLES) {
      return this.buildResult(sensorId, channelId, value, 0);
    }

    const variance = s.m2 / (s.count - 1);
    const stddev   = Math.sqrt(variance);
    const zScore   = stddev > 0 ? Math.abs((value - s.mean) / stddev) : 0;

    return this.buildResult(sensorId, channelId, value, zScore);
  }

  /**
   * Bulk detect anomalies for a batch of readings.
   * Uses setImmediate trampolining for arrays > 1,000 to avoid blocking the
   * event loop (HIGH-010).
   */
  async detectBatch(
    readings: { sensorId: string; channelId: string; value: number }[],
  ): Promise<AnomalyResult[]> {
    if (readings.length <= 1000) {
      return readings.map((r) => this.detect(r.sensorId, r.channelId, r.value));
    }

    // Trampoline for large batches
    const results: AnomalyResult[] = [];
    const CHUNK = 500;

    for (let i = 0; i < readings.length; i += CHUNK) {
      const chunk = readings.slice(i, i + CHUNK);
      results.push(...chunk.map((r) => this.detect(r.sensorId, r.channelId, r.value)));
      if (i + CHUNK < readings.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    return results;
  }

  /**
   * Reset statistics for a specific sensor+channel (e.g. after sensor replacement).
   */
  reset(sensorId: string, channelId: string): void {
    this.stats.delete(`${sensorId}:${channelId}`);
  }

  /** Number of sensor+channel pairs being tracked */
  get trackedCount(): number {
    return this.stats.size;
  }

  private getOrCreateStats(key: string): RunningStats {
    let s = this.stats.get(key);
    if (!s) {
      s = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
      this.stats.set(key, s);
    }
    return s;
  }

  private buildResult(
    sensorId: string,
    channelId: string,
    value: number,
    zScore: number,
  ): AnomalyResult {
    let severity: AnomalyResult['severity'] = 'none';
    if (zScore >= 5.0)      severity = 'severe';
    else if (zScore >= 3.5) severity = 'moderate';
    else if (zScore >= 2.5) severity = 'mild';

    return {
      sensorId,
      channelId,
      value,
      isAnomaly: severity !== 'none',
      zScore,
      severity,
    };
  }
}
