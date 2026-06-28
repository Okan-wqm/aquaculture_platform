/**
 * BatchFeedAssignmentDataLoader
 *
 * Eliminates the N+1 query pattern when resolving batch.feedAssignments in list
 * queries. Batches all batchIds in a GraphQL execution tick into ONE query, then
 * groups results in memory. For a page of 20 batches: 1 query instead of 20.
 *
 * Scope: REQUEST -- each GraphQL request gets its own DataLoader instance so
 * results are never shared across requests (prevents data leakage).
 *
 * @module Batch/DataLoaders
 */
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import DataLoader from 'dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { BatchFeedAssignment } from '../entities/batch-feed-assignment.entity';

@Injectable({ scope: Scope.REQUEST })
export class BatchFeedAssignmentDataLoader {
  /** Loads ALL active feed assignments for a batch. */
  private readonly loader: DataLoader<string, BatchFeedAssignment[]>;

  constructor(
    @InjectRepository(BatchFeedAssignment)
    private readonly feedAssignmentRepository: Repository<BatchFeedAssignment>,
  ) {
    this.loader = createTenantScopedDataLoader<string, BatchFeedAssignment[]>(
      // tenantId is supplied (and guaranteed non-empty) by the factory, which
      // resolves it from the request context fail-closed. Defense-in-depth on
      // top of the request-scoped search_path: a misrouted pooled connection
      // still cannot batch-leak another tenant's rows.
      async (tenantId: string, batchIds: readonly string[]) => {
        const assignments = await this.feedAssignmentRepository.find({
          where: {
            batchId: In([...batchIds]),
            tenantId,
            isActive: true,
            isDeleted: false,
          },
          order: { createdAt: 'DESC' },
        });

        // Group by batchId -- maintain insertion order for deterministic responses
        const grouped = new Map<string, BatchFeedAssignment[]>();
        for (const id of batchIds) {
          grouped.set(id, []);
        }
        for (const assignment of assignments) {
          grouped.get(assignment.batchId)?.push(assignment);
        }

        // Return in the same order as the input batchIds
        return batchIds.map((id) => grouped.get(id) ?? []);
      },
      {
        batchFnName: 'BatchFeedAssignmentDataLoader',
        dataLoaderOptions: {
          // Cache is per-request (Scope.REQUEST) -- no cross-request leakage
          cache: true,
          // Batch all loads within the same tick
          batchScheduleFn: (cb: () => void): ReturnType<typeof setTimeout> => setTimeout(cb, 0),
        },
      },
    );
  }

  /** Load all active feed assignments for a batch */
  async load(batchId: string): Promise<BatchFeedAssignment[]> {
    return this.loader.load(batchId);
  }
}
