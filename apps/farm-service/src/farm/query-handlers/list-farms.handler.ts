import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { DataSource, Like, FindOptionsWhere } from 'typeorm';

import { Farm } from '../entities/farm.entity';
import { ListFarmsQuery } from '../queries/list-farms.query';

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
    @InjectDataSource()
    private readonly dataSource: DataSource,
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

    // Execute through the fail-closed tenant boundary so a lost/wrong tenant
    // context throws instead of returning a silent empty page.
    const [items, total] = await runInTenantRead(
      this.dataSource,
      'farm',
      query.tenantId,
      (queryRunner) =>
        queryRunner.manager.findAndCount(Farm, {
          where,
          relations: query.includePonds ? ['ponds'] : [],
          skip,
          take: limit,
          order: {
            createdAt: 'DESC',
          },
        }),
    );

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
