/**
 * FileCleanupModule
 *
 * Wires the phase 6.2.3 orphan cleanup pipeline in farm-service:
 *
 *   - `StorageModule` (from `@platform/storage`) MUST be
 *     registered in the root app module — this module assumes
 *     `StorageOrphanCleanupService` is already available in the
 *     DI graph.
 *   - Domain-specific `FileReferenceProvider` implementations
 *     are constructed with their repository deps.
 *   - A single `FILE_REFERENCE_PROVIDERS` token aggregates the
 *     providers so `FarmOrphanCleanupService` can inject them
 *     as an array.
 *
 * The module deliberately does NOT import StorageModule itself
 * — StorageModule is `@Global()` and must be configured once at
 * the root app level with the MinIO credentials.
 *
 * Phase 6.2.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { BatchDocumentPathProvider } from './batch-document-path.provider';
import { ChemicalDocumentPathProvider } from './chemical-document-path.provider';
import { FarmOrphanCleanupService } from './farm-orphan-cleanup.service';
import { FILE_REFERENCE_PROVIDERS } from './file-reference-provider';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([BatchDocument, Chemical])],
  providers: [
    BatchDocumentPathProvider,
    {
      provide: ChemicalDocumentPathProvider,
      useFactory: (chemicalRepo: Repository<Chemical>, config: ConfigService) =>
        new ChemicalDocumentPathProvider(
          chemicalRepo,
          config.get<string>('MINIO_BUCKET', 'farm-uploads'),
        ),
      inject: [getRepositoryToken(Chemical), ConfigService],
    },
    {
      provide: FILE_REFERENCE_PROVIDERS,
      useFactory: (
        batchProvider: BatchDocumentPathProvider,
        chemicalProvider: ChemicalDocumentPathProvider,
      ) => [batchProvider, chemicalProvider],
      inject: [BatchDocumentPathProvider, ChemicalDocumentPathProvider],
    },
    FarmOrphanCleanupService,
  ],
  exports: [FarmOrphanCleanupService],
})
export class FileCleanupModule {}
