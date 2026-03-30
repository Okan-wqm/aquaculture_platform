import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomationModule } from '../automation/automation.module';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { ProcessModule } from '../process/process.module';
import { SensorProtocol } from '../database/entities/sensor-protocol.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { BatchProcessorService } from './batch-processor.service';
import { DataIngestionService } from './data-ingestion.service';
import { DataProcessorService } from './data-processor.service';
import { MqttListenerService } from './mqtt-listener.service';
import { SensorTopicCacheService } from './sensor-topic-cache.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Sensor, SensorReading, SensorProtocol, SensorDataChannel]),
    EdgeDeviceModule, // For edge device heartbeat handling (no longer circular)
    AutomationModule, // For deployment confirmation in MQTT responses
    ProcessModule, // For ScadaDeployLogService in MQTT response handling
  ],
  providers: [
    BatchProcessorService,
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
    SensorTopicCacheService,
  ],
  exports: [
    BatchProcessorService,
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
    SensorTopicCacheService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class IngestionModule {}
