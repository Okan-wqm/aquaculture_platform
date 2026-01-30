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
import { EventEmitterModule } from '@nestjs/event-emitter';

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
import { WorkOrder } from '../maintenance/entities/work-order.entity';
import { MaintenanceSchedule } from '../maintenance/entities/maintenance-schedule.entity';
import { SparePart } from '../maintenance/entities/spare-part.entity';

// Feed entity
import { Feed } from '../feed/entities/feed.entity';

// Harvest entity
import { HarvestRecord } from '../harvest/entities/harvest-record.entity';

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
];

@Module({
  imports: [
    // EventEmitter is already configured in SchedulerModule,
    // but we import it here for module independence
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      ignoreErrors: false,
      maxListeners: 20,
    }),

    // TypeORM entities needed by listeners
    TypeOrmModule.forFeature([
      // Batch related
      Batch,
      MortalityRecord,
      TankBatch,

      // Species and Site
      Species,
      Site,

      // Maintenance related
      WorkOrder,
      MaintenanceSchedule,
      SparePart,

      // Feed and Harvest
      Feed,
      HarvestRecord,
    ]),
  ],
  providers: [...EventListeners],
  exports: [...EventListeners],
})
export class EventListenersModule {}
