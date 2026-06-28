/**
 * GraphQL Context Factory
 *
 * Creates per-request DataLoader instances for equipment batch metrics.
 * Eliminates N+1 queries: ~200 queries → 4 queries per request.
 *
 * DataLoaders are created per request. Each loader resolves the active
 * tenant fail-closed from the request context at batch-tick time (via
 * createTenantScopedDataLoader), so tenant id and schema are never passed
 * eagerly and a tenant-blind batch is structurally impossible.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { EquipmentDataLoaders } from './types/graphql-context.types';
import { createTankBatchLoader } from '../equipment/dataloaders/tank-batch.dataloader';
import { createBatchSpeciesLoader } from '../equipment/dataloaders/batch-species.dataloader';
import { createFeedSelectionLoader } from '../equipment/dataloaders/feed-selection.dataloader';

@Injectable()
export class GraphQLContextFactory {
  constructor(
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
  ) {}

  createLoaders(): EquipmentDataLoaders {
    return {
      tankBatchLoader: createTankBatchLoader(this.tankBatchRepository),
      batchSpeciesLoader: createBatchSpeciesLoader(this.tankBatchRepository),
      feedSelectionLoader: createFeedSelectionLoader(this.tankBatchRepository),
    };
  }
}
