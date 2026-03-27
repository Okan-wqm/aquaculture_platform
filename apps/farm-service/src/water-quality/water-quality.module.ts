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
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

// Entities
import { WaterQualityMeasurement } from './entities/water-quality-measurement.entity';
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
    ]),
    CqrsModule,
  ],
  providers: [
    WaterQualityService,
    ParameterConfigCacheService,
    WaterQualityEvaluationService,
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
  ],
})
export class WaterQualityModule {}
