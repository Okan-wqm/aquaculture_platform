/**
 * List Suppliers Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListSuppliersQuery } from '../queries/list-suppliers.query';
import { Supplier } from '../entities/supplier.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListSuppliersQuery)
export class ListSuppliersHandler implements IQueryHandler<ListSuppliersQuery> {
  constructor(
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
  ) {}

  async execute(query: ListSuppliersQuery): Promise<PaginatedResult<Supplier>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.supplierRepository.createQueryBuilder('supplier');
    queryBuilder.where('supplier.tenantId = :tenantId', { tenantId });
    // DEFAULT: Only return non-deleted suppliers
    queryBuilder.andWhere('supplier.isDeleted = :isDeleted', { isDeleted: false });

    if (filter?.type) {
      queryBuilder.andWhere('supplier.type = :type', { type: filter.type });
    }

    if (filter?.status) {
      queryBuilder.andWhere('supplier.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('supplier.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.country) {
      queryBuilder.andWhere('supplier.country = :country', { country: filter.country });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(supplier.name ILIKE :search OR supplier.code ILIKE :search OR supplier.email ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting
    queryBuilder.orderBy(`supplier.${sortBy}`, sortOrder);

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
