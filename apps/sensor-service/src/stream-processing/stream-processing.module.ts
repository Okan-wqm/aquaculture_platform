import { Module } from '@nestjs/common';

import { AnomalyDetectorService } from './anomaly-detector.service';
import { RealTimeAnalyzerService } from './real-time-analyzer.service';

/**
 * Stream Processing Module
 *
 * Per-message real-time analysis services for the sensor ingestion path,
 * designed for O(1) per-call overhead and safe to invoke on every incoming
 * MQTT data point.
 *
 * Task 7 (100-tenant readiness plan): the no-op Kafka placeholder
 * service is DELETED, not replaced — CI bans the class name and the
 * kafkajs dependency (telemetry-architecture-contract invariant).
 */
@Module({
  providers: [AnomalyDetectorService, RealTimeAnalyzerService],
  exports: [AnomalyDetectorService, RealTimeAnalyzerService],
})
export class StreamProcessingModule {}
