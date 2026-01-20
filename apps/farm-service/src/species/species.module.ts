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
import { CqrsModule } from '@platform/cqrs';

// Entities
import { Species } from './entities/species.entity';

// Handlers
import { SpeciesHandlers } from './handlers';

// Resolvers
import { SpeciesResolver } from './resolvers/species.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([Species]),
    CqrsModule,
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
