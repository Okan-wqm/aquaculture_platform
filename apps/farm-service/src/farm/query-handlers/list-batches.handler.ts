import { Injectable, Logger } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { ListPondBatchesQuery } from '../queries/list-batches.query';
import { PondBatch } from '../entities/batch.entity';
import { PaginatedResult } from './list-farms.handler';

/**
 * List Pond Batches Query Handler
 * Handles retrieval of pond batches with pagination and filters (Farm module version)
 * Note: Renamed from ListBatchesQueryHandler to avoid conflict with Batch module
 */
@Injectable()
@QueryHandler(ListPondBatchesQuery)
export class ListPondBatchesHandler
  implements IQueryHandler<ListPondBatchesQuery, PaginatedResult<PondBatch>>
{
  private readonly logger = new Logger(ListPondBatchesHandler.name);

  constructor(
    @InjectRepository(PondBatch)
    private readonly batchRepository: Repository<PondBatch>,
  ) {}

  async execute(query: ListPondBatchesQuery): Promise<PaginatedResult<PondBatch>> {
    this.logger.debug(
      `Listing batches for tenant ${query.tenantId}, page ${query.pagination.page}`,
    );

    const { page, limit } = query.pagination;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: FindOptionsWhere<PondBatch> = {
      tenantId: query.tenantId,
    };

    if (query.filters?.status) {
      where.status = query.filters.status;
    }

    if (query.filters?.species) {
      where.species = query.filters.species;
    }

    if (query.filters?.pondId) {
      where.pondId = query.filters.pondId;
    }

    // Execute query with count
    const [items, total] = await this.batchRepository.findAndCount({
      where,
      relations: ['pond'],
      skip,
      take: limit,
      order: {
        stockedAt: 'DESC',
      },
    });

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    };
  }
}
