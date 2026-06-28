/**
 * GetBatchHandler
 *
 * GetBatchQuery'yi işler ve batch'i döner.
 *
 * @module Batch/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Batch } from '../entities/batch.entity';
import { GetBatchQuery } from '../queries/get-batch.query';

@Injectable()
@QueryHandler(GetBatchQuery)
export class GetBatchHandler implements IQueryHandler<GetBatchQuery, Batch> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetBatchQuery): Promise<Batch> {
    const { tenantId, batchId, includeRelations } = query;

    // Read through the fail-closed tenant boundary so a lost/wrong tenant
    // context raises instead of resolving the source schema.
    const batch = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) => {
      const queryBuilder = queryRunner.manager
        .createQueryBuilder(Batch, 'batch')
        .where('batch.id = :batchId', { batchId })
        .andWhere('batch.tenantId = :tenantId', { tenantId });

      if (includeRelations) {
        queryBuilder.leftJoinAndSelect('batch.species', 'species');
      }

      return queryBuilder.getOne();
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    return batch;
  }
}
