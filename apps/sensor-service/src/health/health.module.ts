import { Module } from '@nestjs/common';

import { SharedMqttModule } from '../shared-mqtt/shared-mqtt.module';
import { HealthController } from './health.controller';

/**
 * Health Module
 * Provides health check endpoints for kubernetes probes
 */
@Module({
  imports: [SharedMqttModule],
  controllers: [HealthController],
})
 
export class HealthModule {}
