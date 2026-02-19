import { Injectable, Logger, Optional } from '@nestjs/common';

import { MqttClientService, MqttMessageHandler } from '../shared-mqtt/mqtt-client.service';

/**
 * MQTT Subscriber Service
 *
 * Thin wrapper that registers named message handlers on the shared
 * MqttClientService.  Consumers call addHandler() to receive all
 * MQTT messages without owning a broker connection.
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class MqttSubscriberService {
  private readonly logger = new Logger(MqttSubscriberService.name);

  constructor(
    @Optional()
    private readonly mqttClient: MqttClientService | null,
  ) {}

  /**
   * Register a message handler for all incoming MQTT messages.
   * Returns a cleanup function that removes the handler.
   */
  addHandler(handler: MqttMessageHandler): () => void {
    if (!this.mqttClient) {
      this.logger.warn('MqttClientService unavailable — handler not registered');
      return () => { /* noop */ };
    }
    this.mqttClient.addMessageHandler(handler);
    return () => this.mqttClient!.removeMessageHandler(handler);
  }

  /**
   * Subscribe to additional topic patterns at runtime.
   */
  async subscribe(topics: string | string[], qos: 0 | 1 | 2 = 1): Promise<void> {
    if (!this.mqttClient) {
      this.logger.warn('MqttClientService unavailable — cannot subscribe');
      return;
    }
    await this.mqttClient.subscribe(topics, qos);
  }
}
