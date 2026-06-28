/**
 * BatchLocationDataLoader
 *
 * Eliminates the N+1 query pattern when resolving batch.locations in list queries.
 * Batches all batchIds in a GraphQL execution tick into ONE query, then groups
 * results in memory. For a page of 20 batches: 1 query instead of 20.
 *
 * Scope: REQUEST -- each GraphQL request gets its own DataLoader instance so
 * results are never shared across requests (prevents data leakage).
 *
 * @module Batch/DataLoaders
 */
import { getRequestContext } from '@aquaculture/backend-common/logging';
import DataLoader from 'dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { BatchLocation } from '../entities/batch-location.entity';

@Injectable({ scope: Scope.REQUEST })
export class BatchLocationDataLoader {
  /** Loads ALL current locations for a batch. */
  private readonly loader: DataLoader<string, BatchLocation[]>;

  constructor(
    @InjectRepository(BatchLocation)
    private readonly locationRepository: Repository<BatchLocation>,
  ) {
    this.loader = new DataLoader<string, BatchLocation[]>(
      async (batchIds: readonly string[]) => {
        // Defense-in-depth: explicit tenant filter on top of the request-scoped
        // search_path (AsyncLocalStorage frame propagates through the batch tick).
        const tenantId = getRequestContext().tenantId;
        const locations = await this.locationRepository.find({
          where: {
            batchId: In([...batchIds]),
            tenantId,
            isCurrentLocation: true,
          },
          order: { movedAt: 'DESC' },
        });

        // Group by batchId -- maintain insertion order for deterministic responses
        const grouped = new Map<string, BatchLocation[]>();
        for (const id of batchIds) {
          grouped.set(id, []);
        }
        for (const loc of locations) {
          grouped.get(loc.batchId)?.push(loc);
        }

        // Return in the same order as the input batchIds
        return batchIds.map((id) => grouped.get(id) ?? []);
      },
      {
        // Cache is per-request (Scope.REQUEST) -- no cross-request leakage
        cache: true,
        // Batch all loads within the same tick
        batchScheduleFn: (cb: () => void): ReturnType<typeof setTimeout> => setTimeout(cb, 0),
      },
    );
  }

  /** Load all current locations for a batch */
  async load(batchId: string): Promise<BatchLocation[]> {
    return this.loader.load(batchId);
  }
}
