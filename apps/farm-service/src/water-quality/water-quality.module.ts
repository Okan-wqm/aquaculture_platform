/**
 * Water Quality Module
 *
 * Su kalitesi ölçümleri ve analizleri.
 * Sensör entegrasyonu ve alarm tetikleme.
 *
 * Sağladığı özellikler:
 * - Kapsamlı su parametreleri takibi
 * - Otomatik/manuel ölçüm desteği
 * - Limit bazlı değerlendirme
 * - Alarm entegrasyonu
 * - Trend analizi
 * - Dinamik parametre konfigurasyonu (CRUD + template)
 *
 * @module WaterQuality
 */
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { WaterQualityMeasurement } from './entities/water-quality-measurement.entity';
import { SensorTemperatureLatest } from './entities/sensor-temperature-latest.entity';
import { WaterQualityParameterConfig } from './entities/water-quality-parameter-config.entity';
import { WaterQualityParamEquipment } from './entities/water-quality-param-equipment.entity';

// Related entities
import { Tank } from '../tank/entities/tank.entity';
import { Equipment } from '../equipment/entities/equipment.entity';

// Service
import { WaterQualityService } from './water-quality.service';

// Resolvers
import { WaterQualityResolver } from './water-quality.resolver';
import { WaterQualityParameterConfigResolver } from './water-quality-parameter-config.resolver';

// Parameter Config Command Handlers
import {
  CreateParameterConfigHandler,
  UpdateParameterConfigHandler,
  DeleteParameterConfigHandler,
  BulkCreateFromTemplateHandler,
  ReorderParameterConfigsHandler,
  CreateParamEquipmentHandler,
  UpdateParamEquipmentHandler,
  DeleteParamEquipmentHandler,
  BulkMapParamsEquipmentHandler,
} from './handlers';

// Parameter Config Query Handlers
import { WaterQualityQueryHandlers } from './query-handlers';

// Parameter Config Services
import { ParameterConfigCacheService } from './services/parameter-config-cache.service';
import { WaterQualityEvaluationService } from './services/water-quality-evaluation.service';
import { WaterQualityValidationService } from './services/water-quality-validation.service';
import { WaterQualityParameterConfigSeederService } from './services/water-quality-parameter-config-seeder.service';

// Phase 7.5 — event handler that auto-seeds default WQ parameter
// configs when a new tenant is provisioned. The handler also runs
// sibling seeders (species, feeding protocols, etc.) so each
// onboarding-owning module gets pulled in via a module import.
import { TenantOnboardingEventHandler } from './event-handlers/tenant-onboarding.event-handler';
import { SpeciesModule } from '../species/species.module';
import { FeedModule } from '../feed/feed.module';
import { RegulatoryModule } from '../regulatory/regulatory.module';
import { EquipmentModule } from '../equipment/equipment.module';

const CommandHandlers = [
  CreateParameterConfigHandler,
  UpdateParameterConfigHandler,
  DeleteParameterConfigHandler,
  BulkCreateFromTemplateHandler,
  ReorderParameterConfigsHandler,
  CreateParamEquipmentHandler,
  UpdateParamEquipmentHandler,
  DeleteParamEquipmentHandler,
  BulkMapParamsEquipmentHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WaterQualityMeasurement,
      WaterQualityParameterConfig,
      WaterQualityParamEquipment,
      Tank,
      Equipment,
      SensorTemperatureLatest,
    ]),
    // Onboarding handler fans out to sibling seeders. Each source
    // module re-exports its seeder service so the handler can
    // inject across module boundaries without the seeders leaking
    // into unrelated consumer surfaces.
    SpeciesModule,
    FeedModule,
    RegulatoryModule,
    EquipmentModule,
  ],
  providers: [
    WaterQualityService,
    // SEC-HIGH-051 / SEC-HIGH-052: site authz SSoT + mobile-feature guard.
    SiteAuthorizationService,
    MobileFeatureGuard,
    ParameterConfigCacheService,
    WaterQualityEvaluationService,
    WaterQualityValidationService,
    WaterQualityParameterConfigSeederService,
    TenantOnboardingEventHandler,
    WaterQualityResolver,
    WaterQualityParameterConfigResolver,
    ...CommandHandlers,
    ...WaterQualityQueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    WaterQualityService,
    ParameterConfigCacheService,
    WaterQualityEvaluationService,
    WaterQualityValidationService,
    WaterQualityParameterConfigSeederService,
  ],
})
export class WaterQualityModule {}
