import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { SensorTypeModule } from '../sensor-type/sensor-type.module';

import { SensorResolver } from './resolvers/sensor.resolver';
import { SensorReadingResolver } from './resolvers/sensor-reading.resolver';
import { CalibrationService } from './services/calibration.service';
import { DataQualityService } from './services/data-quality.service';
import { ReadingMapperRegistry } from './services/reading-mapper.service';
import { SensorIngestionService } from './services/sensor-ingestion.service';
import { SensorQueryService } from './services/sensor-query.service';

/**
 * Sensor Module
 * Contains all sensor-related functionality including:
 * - Sensor device management
 * - High-throughput data ingestion with calibration
 * - Time-series queries with TimescaleDB
 * - Data quality assessment
 *
 * Architecture:
 * - CalibrationService: Strategy pattern for flexible calibration algorithms
 * - ReadingMapperRegistry: Registry pattern for sensor type mapping
 * - DataQualityService: Data validation and quality scoring
 * - SensorIngestionService: High-throughput ingestion with resilience
 * - SensorQueryService: Optimized TimescaleDB queries
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Sensor, SensorReading, SensorDataChannel]),
    SensorTypeModule,
  ],
  providers: [
    // Resolvers
    SensorResolver,
    // Federation entity owner for SensorReading (Scope B Phase S1.2).
    // Hosts the `__resolveReference` callback the gateway invokes when
    // farm-service's `Tank.sensorReadings` returns `{ __typename, id }`
    // stubs. See sensor-reading.resolver.ts docblock for tenant-isolation
    // discipline notes.
    SensorReadingResolver,

    // Core Services
    SensorIngestionService,
    SensorQueryService,

    // Support Services (SOLID - Single Responsibility)
    CalibrationService,
    DataQualityService,
    ReadingMapperRegistry,
  ],
  exports: [
    SensorIngestionService,
    SensorQueryService,
    CalibrationService,
    DataQualityService,
    ReadingMapperRegistry,
  ],
})
 
export class SensorModule {}
