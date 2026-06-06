import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FarmDocument } from '../../document/entities/farm-document.entity';
import { FileReferenceProvider } from './file-reference-provider';

@Injectable()
export class FarmDocumentPathProvider implements FileReferenceProvider {
  readonly name = 'FarmDocument.objectKey';

  constructor(
    @InjectRepository(FarmDocument)
    private readonly repo: Repository<FarmDocument>,
  ) {}

  async collectLivePaths(): Promise<string[]> {
    const rows = await this.repo
      .createQueryBuilder('d')
      .select('d.objectKey', 'objectKey')
      .where('d.objectKey IS NOT NULL')
      .andWhere('(d.state <> :deleted OR d.legalHold = true)', {
        deleted: 'DELETED',
      })
      .getRawMany<{ objectKey: string | null }>();

    return rows
      .map((r) => r.objectKey)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
  }
}
