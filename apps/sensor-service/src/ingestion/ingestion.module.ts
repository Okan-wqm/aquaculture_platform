import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@platform/backend-common';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorProtocol } from '../database/entities/sensor-protocol.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';

import { DataIngestionService } from './data-ingestion.service';
import { DataProcessorService } from './data-processor.service';
import { MqttListenerService } from './mqtt-listener.service';
import { SensorTopicCacheService } from './sensor-topic-cache.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Sensor, SensorReading, SensorProtocol, SensorDataChannel]),
    forwardRef(() => EdgeDeviceModule), // For edge device heartbeat handling
    // Redis for sensor-topic caching (critical for MQTT message routing performance)
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        host: configService.get<string>('REDIS_HOST', 'localhost'),
        port: configService.get<number>('REDIS_PORT', 6379),
        password: configService.get<string>('REDIS_PASSWORD'),
        keyPrefix: 'sensor-service:',
      }),
    }),
  ],
  providers: [
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
    SensorTopicCacheService,
  ],
  exports: [
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
    SensorTopicCacheService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class IngestionModule {}
