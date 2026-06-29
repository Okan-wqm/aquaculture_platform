/**
 * Fish Health Module
 *
 * Balık sağlığı takibi ve yönetimi.
 * Hastalık, tedavi ve karantina yönetimi.
 *
 * Sağladığı özellikler:
 * - Sağlık olayları kaydı
 * - Hastalık/belirti takibi
 * - Tedavi protokolleri
 * - Karantina yönetimi
 * - Veteriner konsültasyonları
 * - Laboratuvar sonuçları
 *
 * @module FishHealth
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { HealthEvent } from './entities/health-event.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { Tank } from '../tank/entities/tank.entity';

// Services
import { HealthEventService } from './services/health-event.service';
import { BatchHarvestEligibilityService } from './services/batch-harvest-eligibility.service';

// Resolvers
import { HealthEventResolver } from './resolvers/health-event.resolver';

// Read query handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetHealthEventHandler } from './handlers/get-health-event.handler';
import { ListHealthEventsHandler } from './handlers/list-health-events.handler';
import { ListHealthEventsByBatchHandler } from './handlers/list-health-events-by-batch.handler';
import { ListCriticalHealthEventsHandler } from './handlers/list-critical-health-events.handler';
import { ListOverdueFollowUpsHandler } from './handlers/list-overdue-follow-ups.handler';
import { GetHealthEventStatsHandler } from './handlers/get-health-event-stats.handler';

const HealthEventQueryHandlers = [
  GetHealthEventHandler,
  ListHealthEventsHandler,
  ListHealthEventsByBatchHandler,
  ListCriticalHealthEventsHandler,
  ListOverdueFollowUpsHandler,
  GetHealthEventStatsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HealthEvent,
      Batch,
      Tank,
    ]),
  ],
  providers: [
    // Services
    HealthEventService,
    BatchHarvestEligibilityService,
    // Resolvers
    HealthEventResolver,
    // Query handlers
    ...HealthEventQueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    HealthEventService,
    // Exported so the harvest module can inject the eligibility check
    // into its command handler without re-declaring the HealthEvent repo.
    BatchHarvestEligibilityService,
  ],
})
export class FishHealthModule {}
