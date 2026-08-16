/**
 * EventListeners Module
 *
 * NestJS module that provides event listeners for the farm service.
 * Handles all domain events and triggers appropriate follow-up actions.
 *
 * This module:
 * - Listens to batch lifecycle events (creation, mortality, harvest)
 * - Handles maintenance and work order events
 * - Processes inventory and stock alerts
 * - Manages feeding events and statistics
 *
 * Events are handled asynchronously to not block the main request flow.
 * Each listener performs logging, database updates, and emits follow-up events.
 *
 * @module Events
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// ============================================================================
// ENTITIES
// ============================================================================

// Batch entities
import { Batch } from '../batch/entities/batch.entity';
import { MortalityRecord } from '../batch/entities/mortality-record.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';

// Species entity
import { Species } from '../species/entities/species.entity';

// Site entity
import { Site } from '../site/entities/site.entity';

// FarmStockModule exports the shared FarmStockProjectionService (the SSoT
// refreshContainers) that FarmStockProjectionListener drives event-driven.
import { FarmStockModule } from '../farm-stock/farm-stock.module';
import { FeedingProtocolModule } from '../feeding-protocol/feeding-protocol.module';

// ============================================================================
// LISTENERS
// ============================================================================

import {
  BatchCreatedListener,
  MortalityRecordedListener,
  HarvestCompletedListener,
  MaintenanceScheduleDueListener,
  LowStockAlertListener,
  FarmStockProjectionListener,
  SensorTemperatureProjectionListener,
} from './listeners';

/**
 * All event listeners
 */
const EventListeners = [
  BatchCreatedListener,
  MortalityRecordedListener,
  HarvestCompletedListener,
  MaintenanceScheduleDueListener,
  LowStockAlertListener,
  FarmStockProjectionListener,
  SensorTemperatureProjectionListener,
];

@Module({
  imports: [
    // TypeORM entities needed by listeners
    TypeOrmModule.forFeature([
      // Batch related
      Batch,
      MortalityRecord,
      TankBatch,

      // Species and Site
      Species,
      Site,
    ]),
    // Shared FarmStockProjectionService for the event-driven read-model listener.
    FarmStockModule,
    FeedingProtocolModule,
  ],
  providers: [...EventListeners],
  exports: [...EventListeners],
})
export class EventListenersModule {}
