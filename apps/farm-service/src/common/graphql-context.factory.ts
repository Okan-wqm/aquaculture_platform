/**
 * GraphQL Context Factory
 *
 * Creates per-request DataLoader instances for equipment batch metrics.
 * Eliminates N+1 queries: ~200 queries → 4 queries per request.
 *
 * DataLoaders are created lazily per tenant to avoid unnecessary work
 * for requests that don't touch equipment.
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

  createLoaders(tenantId: string, schema: string): EquipmentDataLoaders {
    return {
      tankBatchLoader: createTankBatchLoader(this.tankBatchRepository, tenantId, schema),
      batchSpeciesLoader: createBatchSpeciesLoader(this.tankBatchRepository, tenantId, schema),
      feedSelectionLoader: createFeedSelectionLoader(this.tankBatchRepository, tenantId, schema),
    };
  }
}
