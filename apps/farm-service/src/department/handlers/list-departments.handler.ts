/**
 * List Departments Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListDepartmentsQuery } from '../queries/list-departments.query';
import { Department } from '../entities/department.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListDepartmentsQuery)
export class ListDepartmentsHandler implements IQueryHandler<ListDepartmentsQuery> {
  constructor(
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
  ) {}

  async execute(query: ListDepartmentsQuery): Promise<PaginatedResult<Department>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.departmentRepository.createQueryBuilder('department');
    queryBuilder.where('department.tenantId = :tenantId', { tenantId });
    // DEFAULT: Only return non-deleted departments
    queryBuilder.andWhere('department.isDeleted = :isDeleted', { isDeleted: false });

    if (filter?.siteId) {
      queryBuilder.andWhere('department.siteId = :siteId', { siteId: filter.siteId });
    }

    if (filter?.type) {
      queryBuilder.andWhere('department.type = :type', { type: filter.type });
    }

    if (filter?.status) {
      queryBuilder.andWhere('department.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('department.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(department.name ILIKE :search OR department.code ILIKE :search OR department.description ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Join site for additional info
    queryBuilder.leftJoinAndSelect('department.site', 'site');

    // Apply sorting
    queryBuilder.orderBy(`department.${sortBy}`, sortOrder);

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
