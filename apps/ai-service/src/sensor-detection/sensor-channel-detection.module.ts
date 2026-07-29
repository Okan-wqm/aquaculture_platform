import { Module } from '@nestjs/common';

import { ToolRegistryModule } from '../tools/tool-registry.module';
import { SensorChannelDetectionResponder } from './sensor-channel-detection.responder';

/**
 * SENSOR-MEDIUM-070: hosts the `request.ai.sensor.detectChannels` NATS
 * responder. It runs the read-only sensor-config tools via ToolExecutorService
 * (exported by ToolRegistryModule); the tools themselves are discovered from
 * SensorConfigToolsModule, already registered in AppModule. A @MessagePattern
 * handler registers as a "controller" on the microservice transport.
 */
@Module({
  imports: [ToolRegistryModule],
  controllers: [SensorChannelDetectionResponder],
})
export class SensorChannelDetectionModule {}
