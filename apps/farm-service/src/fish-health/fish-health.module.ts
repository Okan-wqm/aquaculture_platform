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
 * - Regulatory field capture: lice counts, treatment applications,
 *   welfare assessments, escape incidents (report assemblers read these)
 *
 * @module FishHealth
 */
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { HealthEvent } from './entities/health-event.entity';
import { LiceCount } from './entities/lice-count.entity';
import { TreatmentApplication } from './entities/treatment-application.entity';
import { WelfareAssessment } from './entities/welfare-assessment.entity';
import { EscapeIncident } from './entities/escape-incident.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { Tank } from '../tank/entities/tank.entity';

// Services
import { HealthEventService } from './services/health-event.service';
import { BatchHarvestEligibilityService } from './services/batch-harvest-eligibility.service';
import { LiceCountService } from './services/lice-count.service';
import { TreatmentApplicationService } from './services/treatment-application.service';
import { WelfareAssessmentService } from './services/welfare-assessment.service';
import { EscapeIncidentService } from './services/escape-incident.service';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';

// Resolvers
import { HealthEventResolver } from './resolvers/health-event.resolver';
import { FieldCaptureResolver } from './resolvers/field-capture.resolver';

// Read query handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetHealthEventHandler } from './handlers/get-health-event.handler';
import { ListHealthEventsHandler } from './handlers/list-health-events.handler';
import { ListHealthEventsByBatchHandler } from './handlers/list-health-events-by-batch.handler';
import { ListCriticalHealthEventsHandler } from './handlers/list-critical-health-events.handler';
import { ListOverdueFollowUpsHandler } from './handlers/list-overdue-follow-ups.handler';
import { GetHealthEventStatsHandler } from './handlers/get-health-event-stats.handler';
import { ListLiceCountsHandler } from './handlers/list-lice-counts.handler';
import { ListTreatmentApplicationsHandler } from './handlers/list-treatment-applications.handler';
import { ListWelfareAssessmentsHandler } from './handlers/list-welfare-assessments.handler';
import { ListEscapeIncidentsHandler } from './handlers/list-escape-incidents.handler';

const HealthEventQueryHandlers = [
  GetHealthEventHandler,
  ListHealthEventsHandler,
  ListHealthEventsByBatchHandler,
  ListCriticalHealthEventsHandler,
  ListOverdueFollowUpsHandler,
  GetHealthEventStatsHandler,
];

const FieldCaptureQueryHandlers = [
  ListLiceCountsHandler,
  ListTreatmentApplicationsHandler,
  ListWelfareAssessmentsHandler,
  ListEscapeIncidentsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HealthEvent,
      LiceCount,
      TreatmentApplication,
      WelfareAssessment,
      EscapeIncident,
      Batch,
      Tank,
    ]),
  ],
  providers: [
    // Services
    HealthEventService,
    BatchHarvestEligibilityService,
    LiceCountService,
    TreatmentApplicationService,
    WelfareAssessmentService,
    EscapeIncidentService,
    // Same local-provider pattern regulatory/feeding/equipment modules use —
    // the service only injects DataSource; no module cycle with water-quality.
    WaterTemperatureService,
    // Phase 6 (FARM-HIGH-214): welfare + escape are plain inserts, so mobile
    // offline-queue replays dedup through the farm_mobile_command_receipts
    // ledger (same at-most-once contract as mortality/cull/harvest).
    MobileCommandReceiptService,
    // Resolvers
    HealthEventResolver,
    FieldCaptureResolver,
    // Query handlers
    ...HealthEventQueryHandlers,
    ...FieldCaptureQueryHandlers,
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
