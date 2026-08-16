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
import { GetWaterQualityOverviewResponder } from './responders/get-water-quality-overview.responder';
import { SensorTemperatureLatest } from './entities/sensor-temperature-latest.entity';
import { SensorTemperatureDaily } from './entities/sensor-temperature-daily.entity';
import { WaterQualityParameterConfig } from './entities/water-quality-parameter-config.entity';
import { WaterQualityParamEquipment } from './entities/water-quality-param-equipment.entity';

// Related entities
import { Tank } from '../tank/entities/tank.entity';
import { Equipment } from '../equipment/entities/equipment.entity';

// Service
import { WaterQualityService } from './water-quality.service';
import { WaterTemperatureService } from './services/water-temperature.service';
import { ProtocolRateService } from '../feeding-protocol/services/protocol-rate.service';
import { DayPlanRecalcService } from '../feeding-protocol/services/day-plan-recalc.service';

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
      SensorTemperatureDaily,
    ]),
  ],
  controllers: [GetWaterQualityOverviewResponder],
  providers: [
    WaterQualityService,
    // P-31 sıcaklık tetiklemesi — stateless recalc servisleri doğrudan sağlanır.
    ProtocolRateService,
    DayPlanRecalcService,
    // Etkin sıcaklık zinciri (sensör→manuel→none) — effectiveUnitTemperatures sorgusu okur.
    WaterTemperatureService,
    // SEC-HIGH-051 / SEC-HIGH-052: site authz SSoT + mobile-feature guard.
    SiteAuthorizationService,
    MobileFeatureGuard,
    ParameterConfigCacheService,
    WaterQualityEvaluationService,
    WaterQualityValidationService,
    WaterQualityParameterConfigSeederService,
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
