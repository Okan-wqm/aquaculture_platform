import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { SensorResolver } from './resolvers/sensor.resolver';
import { SensorIngestionService } from './services/sensor-ingestion.service';
import { SensorQueryService } from './services/sensor-query.service';

/**
 * Sensor Module
 * Contains all sensor-related functionality including:
 * - Sensor device management
 * - High-throughput data ingestion
 * - Time-series queries with TimescaleDB
 */
@Module({
  imports: [TypeOrmModule.forFeature([Sensor, SensorReading])],
  providers: [
    // Resolvers
    SensorResolver,

    // Services
    SensorIngestionService,
    SensorQueryService,
  ],
  exports: [SensorIngestionService, SensorQueryService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class SensorModule {}
