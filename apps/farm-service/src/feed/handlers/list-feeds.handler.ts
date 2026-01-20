/**
 * List Feeds Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListFeedsQuery } from '../queries/list-feeds.query';
import { Feed } from '../entities/feed.entity';
import { FeedSite } from '../entities/feed-site.entity';
import { FeedTypeSpecies } from '../entities/feed-type-species.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListFeedsQuery)
export class ListFeedsHandler implements IQueryHandler<ListFeedsQuery> {
  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
  ) {}

  async execute(query: ListFeedsQuery): Promise<PaginatedResult<Feed>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.feedRepository.createQueryBuilder('feed');
    queryBuilder.where('feed.tenantId = :tenantId', { tenantId });
    // DEFAULT: Only return non-deleted feeds
    queryBuilder.andWhere('feed.isDeleted = :isDeleted', { isDeleted: false });

    if (filter?.type) {
      queryBuilder.andWhere('feed.type = :type', { type: filter.type });
    }

    if (filter?.status) {
      queryBuilder.andWhere('feed.status = :status', { status: filter.status });
    }

    if (filter?.pelletSize) {
      queryBuilder.andWhere('feed.pelletSize = :pelletSize', { pelletSize: filter.pelletSize });
    }

    if (filter?.supplierId) {
      queryBuilder.andWhere('feed.supplierId = :supplierId', { supplierId: filter.supplierId });
    }

    if (filter?.siteId) {
      queryBuilder.innerJoin(
        FeedSite,
        'feedSite',
        'feedSite.feedId = feed.id AND feedSite.tenantId = :tenantId',
        { tenantId }
      );
      queryBuilder.andWhere('feedSite.siteId = :siteId', { siteId: filter.siteId });
      queryBuilder.andWhere('feedSite.isApproved = true');
    }

    if (filter?.speciesId) {
      queryBuilder.innerJoin(
        FeedTypeSpecies,
        'feedTypeSpecies',
        'feedTypeSpecies.feedId = feed.id AND feedTypeSpecies.tenantId = :tenantId',
        { tenantId }
      );
      queryBuilder.andWhere('feedTypeSpecies.speciesId = :speciesId', { speciesId: filter.speciesId });
      queryBuilder.andWhere('feedTypeSpecies.isActive = true');
      queryBuilder.andWhere('feedTypeSpecies.isDeleted = false');
      queryBuilder.distinct(true);
    }

    if (filter?.targetSpecies) {
      queryBuilder.andWhere(
        `
        EXISTS (
          SELECT 1
          FROM unnest(regexp_split_to_array(coalesce(feed.targetSpecies, ''), '[[:space:]]*,[[:space:]]*')) AS species_list(species)
          WHERE lower(species_list.species) = lower(:species)
        )
        `,
        { species: filter.targetSpecies.trim() }
      );
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('feed.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(feed.name ILIKE :search OR feed.code ILIKE :search OR feed.manufacturer ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting
    queryBuilder.orderBy(`feed.${sortBy}`, sortOrder);

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
