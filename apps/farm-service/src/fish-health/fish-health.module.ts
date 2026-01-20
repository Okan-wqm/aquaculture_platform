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
    // HealthEventService,
    // Handlers will be added
    // Resolvers will be added
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class FishHealthModule {}
