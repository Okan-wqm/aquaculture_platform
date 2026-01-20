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
 *
 * @module WaterQuality
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

// Entities
import { WaterQualityMeasurement } from './entities/water-quality-measurement.entity';

// Related entities
import { Tank } from '../tank/entities/tank.entity';

// Service
import { WaterQualityService } from './water-quality.service';

// Resolver
import { WaterQualityResolver } from './water-quality.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WaterQualityMeasurement,
      Tank,
    ]),
    CqrsModule,
  ],
  providers: [
    WaterQualityService,
    WaterQualityResolver,
  ],
  exports: [
    TypeOrmModule,
    WaterQualityService,
  ],
})
export class WaterQualityModule {}
