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

// Services
import { SpeciesSeederService } from './services/species-seeder.service';

import { RestoreModule } from '../common/services/restore.module';
import { SpeciesAiQueryResponder } from './responders/species-ai-query.responder';

@Module({
  imports: [TypeOrmModule.forFeature([Species, Batch]), RestoreModule],
  // NATS request-reply responders for the farm AI specialists (FARM-MEDIUM-328).
  controllers: [SpeciesAiQueryResponder],
  providers: [...SpeciesHandlers, SpeciesResolver, SpeciesSeederService],
  exports: [TypeOrmModule, SpeciesSeederService],
})
export class SpeciesModule {}
