/**
 * BatchDocumentPathProvider
 *
 * `FileReferenceProvider` implementation for the batch-document
 * table. Selects every `storagePath` on a `BatchDocument` row
 * that the module still considers reachable — which today
 * means every row, since the table has no soft-delete flag.
 *
 * Returned paths are forwarded untouched to the orphan cleanup
 * service; they already match the MinIO object name exactly.
 *
 * Phase 6.2.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BatchDocument } from '../../batch/entities/batch-document.entity';
import { FileReferenceProvider } from './file-reference-provider';

@Injectable()
export class BatchDocumentPathProvider implements FileReferenceProvider {
  readonly name = 'BatchDocument.storagePath';

  constructor(
    @InjectRepository(BatchDocument)
    private readonly repo: Repository<BatchDocument>,
  ) {}

  async collectLivePaths(): Promise<string[]> {
    const rows = await this.repo
      .createQueryBuilder('d')
      .select('d.storagePath', 'storagePath')
      .getRawMany<{ storagePath: string | null }>();
    return rows
      .map((r) => r.storagePath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
}
