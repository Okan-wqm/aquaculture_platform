import { Injectable, Logger } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, FindOptionsWhere } from 'typeorm';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { Farm } from '../entities/farm.entity';

/**
 * Paginated result interface
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * List Farms Query Handler
 * Handles retrieval of farms with pagination and filters
 */
@Injectable()
@QueryHandler(ListFarmsQuery)
export class ListFarmsQueryHandler
  implements IQueryHandler<ListFarmsQuery, PaginatedResult<Farm>>
{
  private readonly logger = new Logger(ListFarmsQueryHandler.name);

  constructor(
    @InjectRepository(Farm)
    private readonly farmRepository: Repository<Farm>,
  ) {}

  async execute(query: ListFarmsQuery): Promise<PaginatedResult<Farm>> {
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
      where.name = Like(`%${query.filters.search}%`);
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
