/**
 * List Species Query Handler
 * @module Species/Handlers
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, ILike } from 'typeorm';
import { ListSpeciesQuery } from '../queries/list-species.query';
import { Species } from '../entities/species.entity';

export interface SpeciesListResult {
  items: Species[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

@QueryHandler(ListSpeciesQuery)
export class ListSpeciesHandler
  implements IQueryHandler<ListSpeciesQuery, SpeciesListResult>
{
  constructor(
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  async execute(query: ListSpeciesQuery): Promise<SpeciesListResult> {
    const { tenantId, filter } = query;

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 20;
    const sortBy = filter?.sortBy ?? 'commonName';
    const sortOrder = filter?.sortOrder ?? 'ASC';

    // Build where conditions
    const where: FindOptionsWhere<Species> = {
      tenantId,
      isDeleted: false, // DEFAULT: Only return non-deleted species
    };

    if (filter?.category) {
      where.category = filter.category;
    }

    if (filter?.waterType) {
      where.waterType = filter.waterType;
    }

    if (filter?.status) {
      where.status = filter.status;
    }

    if (filter?.isActive !== undefined) {
      where.isActive = filter.isActive;
    }

    // Build query
    const queryBuilder = this.speciesRepository
      .createQueryBuilder('species')
      .where(where);

    // Search across multiple fields
    if (filter?.search) {
      const search = `%${filter.search}%`;
      queryBuilder.andWhere(
        '(species.scientificName ILIKE :search OR species.commonName ILIKE :search OR species.localName ILIKE :search OR species.code ILIKE :search)',
        { search },
      );
    }

    // Filter by tags (OR logic - any matching tag)
    if (filter?.tags && filter.tags.length > 0) {
      // PostgreSQL JSONB operator: ?| checks if any of the tags exist
      queryBuilder.andWhere('species.tags ?| :tags', { tags: filter.tags });
    }

    // Filter by isCleanerFish (backward compatibility)
    if (filter?.isCleanerFish !== undefined) {
      queryBuilder.andWhere('species."isCleanerFish" = :isCleanerFish', {
        isCleanerFish: filter.isCleanerFish,
      });
    }

    // Apply sorting
    const validSortFields = [
      'scientificName',
      'commonName',
      'localName',
      'code',
      'category',
      'waterType',
      'status',
      'createdAt',
      'updatedAt',
    ];

    if (validSortFields.includes(sortBy)) {
      queryBuilder.orderBy(
        `species.${sortBy}`,
        sortOrder as 'ASC' | 'DESC',
      );
    } else {
      queryBuilder.orderBy('species.commonName', 'ASC');
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    queryBuilder.skip(offset).take(limit);

    // Execute
    const items = await queryBuilder.getMany();

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total,
    };
  }
}
