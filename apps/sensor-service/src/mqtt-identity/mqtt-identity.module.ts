import { Module } from '@nestjs/common';

import { SensorMqttIdentityResolver } from './sensor-mqtt-identity.resolver';
import { SensorMqttIdentityService } from './sensor-mqtt-identity.service';
import { SensorMqttKeyringService } from './sensor-mqtt-keyring.service';

/**
 * A directly publishing sensor's own broker principal (ADR-047): issuing and
 * rotating it, and resolving it for the broker's CONNECT and ACL hooks.
 */
@Module({
  providers: [SensorMqttKeyringService, SensorMqttIdentityService, SensorMqttIdentityResolver],
  exports: [SensorMqttIdentityService],
})
export class MqttIdentityModule {}
