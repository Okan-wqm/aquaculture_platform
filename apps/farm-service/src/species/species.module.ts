/**
 * Species Module
 *
 * Tür kütüphanesi yönetimi. Akuakültür sisteminde yetiştirilen
 * türlerin master verilerini yönetir.
 *
 * Sağladığı özellikler:
 * - Tür CRUD operasyonları
 * - Optimal su koşulları tanımları
 * - Büyüme parametreleri ve aşamaları
 * - Pazar ve üreme bilgileri
 *
 * @module Species
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Species } from './entities/species.entity';
import { Batch } from '../batch/entities/batch.entity';

// Handlers
import { SpeciesHandlers } from './handlers';

// Resolvers
import { SpeciesResolver } from './resolvers/species.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([Species, Batch]),
  ],
  providers: [
    ...SpeciesHandlers,
    SpeciesResolver,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class SpeciesModule {}
