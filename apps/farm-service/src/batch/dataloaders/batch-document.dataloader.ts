/**
 * BatchDocumentDataLoader
 *
 * Eliminates the N+1 query pattern in BatchResolver document field resolvers.
 * When a `batches` list query returns N batches, the three @ResolveField()
 * methods (documents, healthCertificates, importDocuments) previously executed
 * 3N individual queries. This DataLoader batches all document loads for a
 * GraphQL execution cycle into a single query, then groups results in memory.
 *
 * Scope: REQUEST — each GraphQL request gets its own DataLoader instance so
 * results are never shared across requests (prevents data leakage).
 *
 * Usage in resolver:
 *   @ResolveField()
 *   async documents(@Parent() batch: Batch): Promise<BatchDocumentResponse[]> {
 *     return this.batchDocumentDataLoader.loadAll(batch.id);
 *   }
 *
 * @module Batch/DataLoaders
 */
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import DataLoader from 'dataloader';
import { Injectable, Scope } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { BatchDocument, BatchDocumentType } from '../entities/batch-document.entity';

@Injectable({ scope: Scope.REQUEST })
export class BatchDocumentDataLoader {
  /** Loads ALL active documents for a batch. Filtered by type in the resolver. */
  private readonly allDocsLoader: DataLoader<string, BatchDocument[]>;

  constructor(
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
  ) {
    this.allDocsLoader = createTenantScopedDataLoader<string, BatchDocument[]>(
      // tenantId is supplied (and guaranteed non-empty) by the factory, which
      // resolves it from the request context fail-closed. Defense-in-depth on
      // top of the request-scoped search_path.
      async (tenantId: string, batchIds: readonly string[]) => {
        const documents = await this.documentRepository.find({
          where: {
            batchId: In([...batchIds]),
            tenantId,
            isActive: true,
          },
          order: { createdAt: 'DESC' },
        });

        // Group by batchId — maintain insertion order for deterministic responses
        const grouped = new Map<string, BatchDocument[]>();
        for (const id of batchIds) {
          grouped.set(id, []);
        }
        for (const doc of documents) {
          grouped.get(doc.batchId)?.push(doc);
        }

        // Return in the same order as the input batchIds
        return batchIds.map((id) => grouped.get(id) ?? []);
      },
      {
        batchFnName: 'BatchDocumentDataLoader',
        dataLoaderOptions: {
          // Cache is per-request (Scope.REQUEST) — no cross-request leakage
          cache: true,
          // Batch all loads within the same tick
          batchScheduleFn: (cb: () => void): ReturnType<typeof setTimeout> => setTimeout(cb, 0),
        },
      },
    );
  }

  /** Load all active documents for a batch (all types) */
  async loadAll(batchId: string): Promise<BatchDocument[]> {
    return this.allDocsLoader.load(batchId);
  }

  /** Load documents filtered by type, from the already-batched result */
  async loadByType(batchId: string, documentType: BatchDocumentType): Promise<BatchDocument[]> {
    const all = await this.allDocsLoader.load(batchId);
    return all.filter((d: BatchDocument) => d.documentType === documentType);
  }
}
