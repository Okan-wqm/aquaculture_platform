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

// Maintenance entities
// NOTE: WorkOrder + MaintenanceSchedule were dropped from this module's
// forFeature set when the dead `@OnEvent(MAINTENANCE_SCHEDULE_DUE)` work-order
// creation branch was removed (dead-listeners HIGH) — CronJobsService owns that
// path. SparePart remains: LowStockAlertListener still reads it.
import { SparePart } from '../maintenance/entities/spare-part.entity';

// Feed entity
import { Feed } from '../feed/entities/feed.entity';

// FarmStockModule exports the shared FarmStockProjectionService (the SSoT
// refreshContainers) that FarmStockProjectionListener drives event-driven.
import { FarmStockModule } from '../farm-stock/farm-stock.module';

// ============================================================================
// LISTENERS
// ============================================================================

import {
  BatchCreatedListener,
  MortalityRecordedListener,
  HarvestCompletedListener,
  MaintenanceScheduleDueListener,
  LowStockAlertListener,
  FeedingCompletedListener,
  FarmStockProjectionListener,
  SensorTemperatureProjectionListener,
  SensorMassProjectionListener,
  VfdDriveBindingAttestationListener,
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
  FeedingCompletedListener,
  FarmStockProjectionListener,
  SensorTemperatureProjectionListener,
  // Proves a weight-based feeder's load cell is actually reporting. Without
  // this projection `dispenseControl = weight_based` would be an unbacked
  // claim and the dose planner would have nothing to fail closed on.
  SensorMassProjectionListener,
  // Answers sensor-service's "what is the equipment this drive turns?" — the
  // only place that question can be answered, since equipment identity is here.
  VfdDriveBindingAttestationListener,
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

      // Maintenance related (SparePart only — LowStockAlertListener)
      SparePart,

      // Feed
      Feed,
    ]),
    // Shared FarmStockProjectionService for the event-driven read-model listener.
    FarmStockModule,
  ],
  providers: [...EventListeners],
  exports: [...EventListeners],
})
export class EventListenersModule {}
