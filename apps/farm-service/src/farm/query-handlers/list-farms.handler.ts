import { Injectable, Logger } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere } from 'typeorm';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { Farm } from '../entities/farm.entity';

/**
 * List Farms Query Handler
 * Handles retrieval of farms with pagination and filters
 */
@Injectable()
@QueryHandler(ListFarmsQuery)
export class ListFarmsQueryHandler
  implements IQueryHandler<ListFarmsQuery, PaginatedQueryResult<Farm>>
{
  private readonly logger = new Logger(ListFarmsQueryHandler.name);

  constructor(
    @InjectRepository(Farm)
    private readonly farmRepository: Repository<Farm>,
  ) {}

  async execute(query: ListFarmsQuery): Promise<PaginatedQueryResult<Farm>> {
    this.logger.debug(
      `Listing farms for tenant ${query.tenantId}, page ${query.pagination.page}`,
    );

    const { page, limit } = query.pagination;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: FindOptionsWhere<Farm> = {
      tenantId: query.tenantId,
    };

    if (query.filters?.isActive !== undefined) {
      where.isActive = query.filters.isActive;
    }

    if (query.filters?.search) {
      const escaped = query.filters.search
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      where.name = Like(`%${escaped}%`);
    }

    // Execute query with count
    const [items, total] = await this.farmRepository.findAndCount({
      where,
      relations: query.includePonds ? ['ponds'] : [],
      skip,
      take: limit,
      order: {
        createdAt: 'DESC',
      },
    });

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
