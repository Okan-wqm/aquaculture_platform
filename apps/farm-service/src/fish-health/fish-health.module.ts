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

/**
 * TODO: Fish Health Module - Pending Implementation
 *
 * This module is scaffolded but not yet implemented. Planned features:
 * - HealthEventService for managing health events
 * - Command handlers for CRUD operations
 * - Query handlers for listing and filtering health events
 * - GraphQL resolvers for API exposure
 *
 * Note: Module is imported in AppModule to reserve the namespace and
 * ensure entity registrations are in place for future development.
 */
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
    // TODO: Implement the following:
    // - HealthEventService
    // - CreateHealthEventHandler, UpdateHealthEventHandler, DeleteHealthEventHandler
    // - GetHealthEventHandler, ListHealthEventsHandler
    // - HealthEventResolver
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class FishHealthModule {}
