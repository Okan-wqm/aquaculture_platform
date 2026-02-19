import { Injectable, Logger } from '@nestjs/common';

import { AnomalyDetectorService, AnomalyResult } from './anomaly-detector.service';

/**
 * Analysis result for a single real-time metric.
 */
export interface RealTimeAnalysis {
  sensorId: string;
  channelId: string;
  value: number;
  timestamp: Date;
  anomaly: AnomalyResult;
  rateOfChange: number | null;
}

/**
 * Real-Time Analyzer Service
 *
 * Coordinates per-message real-time analysis on the ingestion path:
 * - Delegates anomaly detection to AnomalyDetectorService
 * - Computes instantaneous rate-of-change (first derivative)
 *
 * Designed to be called synchronously from the MQTT ingestion path
 * with negligible per-call overhead (all operations are O(1)).
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class RealTimeAnalyzerService {
  private readonly logger = new Logger(RealTimeAnalyzerService.name);

  /** Previous value and timestamp per sensor+channel for rate-of-change */
  private readonly lastValues = new Map<string, { value: number; timestamp: Date }>();

  constructor(
    private readonly anomalyDetector: AnomalyDetectorService,
  ) {}

  /**
   * Analyze a single incoming metric value.
   * Safe to call on every ingested data point — all operations are O(1).
   */
  analyze(
    sensorId: string,
    channelId: string,
    value: number,
    timestamp: Date,
  ): RealTimeAnalysis {
    const key = `${sensorId}:${channelId}`;

    // Anomaly detection (Welford online algorithm — O(1))
    const anomaly = this.anomalyDetector.detect(sensorId, channelId, value);

    // Rate of change (delta value / delta time in seconds)
    const prev = this.lastValues.get(key);
    let rateOfChange: number | null = null;
    if (prev) {
      const dtSec = (timestamp.getTime() - prev.timestamp.getTime()) / 1000;
      if (dtSec > 0) {
        rateOfChange = (value - prev.value) / dtSec;
      }
    }

    this.lastValues.set(key, { value, timestamp });

    if (anomaly.isAnomaly) {
      this.logger.warn(
        `Anomaly [${anomaly.severity}] — sensor=${sensorId} channel=${channelId} ` +
        `value=${value} z=${anomaly.zScore.toFixed(2)}`,
      );
    }

    return { sensorId, channelId, value, timestamp, anomaly, rateOfChange };
  }

  /**
   * Reset tracked state for a sensor+channel (e.g. on sensor reconnect).
   */
  reset(sensorId: string, channelId: string): void {
    const key = `${sensorId}:${channelId}`;
    this.lastValues.delete(key);
    this.anomalyDetector.reset(sensorId, channelId);
  }
}
