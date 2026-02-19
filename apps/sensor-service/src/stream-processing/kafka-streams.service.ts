import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Kafka Streams Service
 *
 * Placeholder for future Kafka integration.  The sensor-service currently
 * uses MQTT + TimescaleDB as its primary ingestion stack.  This service
 * will be implemented when the platform migrates high-volume streams to
 * Kafka for cross-service event sourcing.
 *
 * CRITICAL-005: Previously a 1-line stub.
 *
 * NOTE: No Kafka client dependency is imported intentionally.  This service
 * acts as a capability registry so dependent code can check
 * `isEnabled()` before attempting Kafka operations, ensuring the rest
 * of the service starts cleanly without a Kafka broker.
 */
@Injectable()
export class KafkaStreamsService {
  private readonly logger = new Logger(KafkaStreamsService.name);
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.enabled = configService.get<string>('KAFKA_ENABLED', 'false') === 'true';
    if (this.enabled) {
      this.logger.warn(
        'KAFKA_ENABLED=true but KafkaStreamsService is not yet fully implemented. ' +
        'Messages will be logged but not forwarded to Kafka.',
      );
    }
  }

  /**
   * Returns true when Kafka integration is configured and enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Stub publish — logs when Kafka is enabled, no-ops otherwise.
   * Replace with real KafkaJS producer.send() in the full implementation.
   */
  async publish(topic: string, key: string, value: unknown): Promise<void> {
    if (!this.enabled) return;

    this.logger.debug(
      `[STUB] Would publish to Kafka topic="${topic}" key="${key}" value=${JSON.stringify(value)}`,
    );
  }
}
