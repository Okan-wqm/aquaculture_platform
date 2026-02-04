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
import { CqrsModule } from '@platform/cqrs';

// Entities
import { HealthEvent } from './entities/health-event.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { Tank } from '../tank/entities/tank.entity';

// Services
import { HealthEventService } from './services/health-event.service';

// Resolvers
import { HealthEventResolver } from './resolvers/health-event.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HealthEvent,
      Batch,
      Tank,
    ]),
    CqrsModule,
  ],
  providers: [
    // Services
    HealthEventService,
    // Resolvers
    HealthEventResolver,
  ],
  exports: [
    TypeOrmModule,
    HealthEventService,
  ],
})
export class FishHealthModule {}
