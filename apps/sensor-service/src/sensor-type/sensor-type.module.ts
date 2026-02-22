import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../database/entities/sensor-type-definition.entity';

import { SensorTypeResolver } from './sensor-type.resolver';
import { SensorTypeService } from './sensor-type.service';

/**
 * SensorType Module
 * Manages sensor type definitions and industry template operations.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SensorTypeDefinition,
      IndustryTemplate,
      SensorDataChannel,
    ]),
  ],
  providers: [
    SensorTypeResolver,
    SensorTypeService,
  ],
  exports: [
    SensorTypeService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class SensorTypeModule {}
