/**
 * GetBatchHandler
 *
 * GetBatchQuery'yi işler ve batch'i döner.
 *
 * @module Batch/QueryHandlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetBatchQuery } from '../queries/get-batch.query';
import { Batch } from '../entities/batch.entity';

@Injectable()
@QueryHandler(GetBatchQuery)
export class GetBatchHandler implements IQueryHandler<GetBatchQuery, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  async execute(query: GetBatchQuery): Promise<Batch> {
    const { tenantId, batchId, includeRelations } = query;

    const queryBuilder = this.batchRepository
      .createQueryBuilder('batch')
      .where('batch.id = :batchId', { batchId })
      .andWhere('batch.tenantId = :tenantId', { tenantId });

    if (includeRelations) {
      queryBuilder.leftJoinAndSelect('batch.species', 'species');
    }

    const batch = await queryBuilder.getOne();

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    return batch;
  }
}
