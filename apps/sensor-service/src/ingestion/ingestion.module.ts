import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorProtocol } from '../database/entities/sensor-protocol.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { DataIngestionService } from './data-ingestion.service';
import { DataProcessorService } from './data-processor.service';
import { MqttListenerService } from './mqtt-listener.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Sensor, SensorReading, SensorProtocol, SensorDataChannel]),
    forwardRef(() => EdgeDeviceModule), // For edge device heartbeat handling
  ],
  providers: [
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
  ],
  exports: [
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
  ],
})
export class IngestionModule {}
