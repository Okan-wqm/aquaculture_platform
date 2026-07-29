import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NatsV3Client } from '@aquaculture/backend-common/nats';

import { ChannelDetectionLog } from '../database/entities/channel-detection-log.entity';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../database/entities/sensor-type-definition.entity';

import { AI_NATS_CLIENT, ChannelDetectionService } from './channel-detection.service';
import { SensorTypeResolver } from './sensor-type.resolver';
import { SensorTypeService } from './sensor-type.service';

/**
 * SensorType Module
 * Manages sensor type definitions, industry template operations,
 * and AI-driven channel detection.
 */
@Module({
  imports: [
    ConfigModule,
    // SENSOR-MEDIUM-070: outbound NATS request-reply client to ai-service's
    // request.ai.sensor.detectChannels responder. Identity is this service's
    // mTLS NATS cert (ADR-015); the cert CN is the serviceName.
    ClientsModule.register([
      {
        name: AI_NATS_CLIENT,
        customClass: NatsV3Client,
        options: { serviceName: 'sensor-service' },
      },
    ]),
    TypeOrmModule.forFeature([
      SensorTypeDefinition,
      IndustryTemplate,
      SensorDataChannel,
      ChannelDetectionLog,
    ]),
  ],
  providers: [
    SensorTypeResolver,
    SensorTypeService,
    ChannelDetectionService,
  ],
  exports: [
    SensorTypeService,
    ChannelDetectionService,
  ],
})
 
export class SensorTypeModule {}
