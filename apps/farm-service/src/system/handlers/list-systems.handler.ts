/**
 * List Systems Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListSystemsQuery } from '../queries/list-systems.query';
import { System } from '../entities/system.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListSystemsQuery)
export class ListSystemsHandler implements IQueryHandler<ListSystemsQuery> {
  constructor(
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
  ) {}

  async execute(query: ListSystemsQuery): Promise<PaginatedResult<System>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.systemRepository.createQueryBuilder('system');
    queryBuilder.where('system.tenantId = :tenantId', { tenantId });
    queryBuilder.andWhere('system.isDeleted = :isDeleted', { isDeleted: false });

    // Apply filters
    if (filter?.siteId) {
      queryBuilder.andWhere('system.siteId = :siteId', { siteId: filter.siteId });
    }

    if (filter?.departmentId) {
      queryBuilder.andWhere('system.departmentId = :departmentId', { departmentId: filter.departmentId });
    }

    if (filter?.parentSystemId) {
      queryBuilder.andWhere('system.parentSystemId = :parentSystemId', { parentSystemId: filter.parentSystemId });
    }

    if (filter?.type) {
      queryBuilder.andWhere('system.type = :type', { type: filter.type });
    }

    if (filter?.status) {
      queryBuilder.andWhere('system.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('system.isActive = :isActive', { isActive: filter.isActive });
    }

    // Root only filter - get systems without parent
    if (filter?.rootOnly) {
      queryBuilder.andWhere('system.parentSystemId IS NULL');
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(system.name ILIKE :search OR system.code ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Join related entities
    queryBuilder.leftJoinAndSelect('system.site', 'site');
    queryBuilder.leftJoinAndSelect('system.department', 'department');
    queryBuilder.leftJoinAndSelect('system.parentSystem', 'parentSystem');

    // Apply sorting
    queryBuilder.orderBy(`system.${sortBy}`, sortOrder);

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
