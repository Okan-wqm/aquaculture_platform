import { Module } from '@nestjs/common';

import { SensorDataPromotion } from './sensor-data-promotion.service';
import { SensorMqttBrokerAccess } from './sensor-mqtt-broker-access.service';
import { SensorMqttIdentityResolver } from './sensor-mqtt-identity.resolver';
import { SensorMqttIdentityService } from './sensor-mqtt-identity.service';
import { SensorMqttKeyringService } from './sensor-mqtt-keyring.service';

/**
 * A directly publishing sensor's own broker principal (ADR-047): issuing and
 * rotating it, resolving it for the broker's CONNECT and ACL hooks, and the
 * promotion its first data earns.
 */
@Module({
  providers: [
    SensorMqttKeyringService,
    SensorMqttIdentityService,
    SensorMqttBrokerAccess,
    SensorDataPromotion,
    SensorMqttIdentityResolver,
  ],
  exports: [SensorMqttIdentityService, SensorMqttBrokerAccess, SensorDataPromotion],
})
export class MqttIdentityModule {}
