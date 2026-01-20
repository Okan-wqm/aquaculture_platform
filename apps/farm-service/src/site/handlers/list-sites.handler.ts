/**
 * List Sites Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListSitesQuery } from '../queries/list-sites.query';
import { Site } from '../entities/site.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListSitesQuery)
export class ListSitesHandler implements IQueryHandler<ListSitesQuery> {
  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(query: ListSitesQuery): Promise<PaginatedResult<Site>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.siteRepository.createQueryBuilder('site');
    queryBuilder.where('site.tenantId = :tenantId', { tenantId });
    // DEFAULT: Only return non-deleted sites
    queryBuilder.andWhere('site.isDeleted = :isDeleted', { isDeleted: false });

    if (filter?.status) {
      queryBuilder.andWhere('site.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('site.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.country) {
      queryBuilder.andWhere('site.country = :country', { country: filter.country });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(site.name ILIKE :search OR site.code ILIKE :search OR site.description ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting
    queryBuilder.orderBy(`site.${sortBy}`, sortOrder);

    // Apply pagination
    queryBuilder.skip((page - 1) * limit);
    queryBuilder.take(limit);

    // Execute query
    const [items, total] = await queryBuilder.getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
