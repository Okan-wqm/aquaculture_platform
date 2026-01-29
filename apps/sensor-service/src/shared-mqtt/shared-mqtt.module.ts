import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttClientService } from './mqtt-client.service';

/**
 * Shared MQTT Module
 *
 * Provides a shared MQTT client service for the sensor-service.
 * This module is @Global to allow injection anywhere without explicit imports,
 * breaking the circular dependency between IngestionModule and EdgeDeviceModule.
 *
 * Before (circular dependency):
 *   IngestionModule ←→ EdgeDeviceModule (bidirectional forwardRef)
 *
 * After (no circular dependency):
 *   SharedMqttModule (provides MqttClientService)
 *          ↑                    ↑
 *   IngestionModule      EdgeDeviceModule
 *
 * Usage:
 *   1. Import SharedMqttModule in AppModule
 *   2. Inject MqttClientService in any service that needs MQTT
 *   3. Remove forwardRef imports between IngestionModule and EdgeDeviceModule
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [MqttClientService],
  exports: [MqttClientService],
})
export class SharedMqttModule {}
