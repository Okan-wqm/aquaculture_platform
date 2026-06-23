import { Module } from '@nestjs/common';

import { AnomalyDetectorService } from './anomaly-detector.service';
import { RealTimeAnalyzerService } from './real-time-analyzer.service';
import { KafkaStreamsService } from './kafka-streams.service';

/**
 * Stream Processing Module
 *
 * Provides per-message real-time analysis and Kafka integration services
 * for the sensor ingestion path. All services are designed for O(1) per-call
 * overhead and are safe to invoke on every incoming MQTT data point.
 */
@Module({
  providers: [
    AnomalyDetectorService,
    RealTimeAnalyzerService,
    KafkaStreamsService,
  ],
  exports: [
    AnomalyDetectorService,
    RealTimeAnalyzerService,
    KafkaStreamsService,
  ],
})
 
export class StreamProcessingModule {}
