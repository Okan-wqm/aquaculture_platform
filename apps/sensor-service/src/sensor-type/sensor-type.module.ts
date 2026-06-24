import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChannelDetectionLog } from '../database/entities/channel-detection-log.entity';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../database/entities/sensor-type-definition.entity';

import { ChannelDetectionService } from './channel-detection.service';
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
