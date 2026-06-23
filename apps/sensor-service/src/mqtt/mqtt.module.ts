import { Module } from '@nestjs/common';

import { MqttSubscriberService } from './mqtt-subscriber.service';

/**
 * MQTT Module
 *
 * Exports MqttSubscriberService for consumers that need to register
 * message handlers on the shared broker connection without owning it.
 *
 * The actual broker connection is managed by SharedMqttModule (@Global).
 */
@Module({
  providers: [MqttSubscriberService],
  exports: [MqttSubscriberService],
})
 
export class MqttModule {}
