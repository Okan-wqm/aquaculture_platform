import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListConsumablesQuery } from '../queries/list-consumables.query';
import { Consumable } from '../entities/consumable.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListConsumablesQuery)
export class ListConsumablesHandler implements IQueryHandler<ListConsumablesQuery> {
  constructor(
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
  ) {}

  async execute(query: ListConsumablesQuery): Promise<PaginatedResult<Consumable>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    const queryBuilder = this.consumableRepository.createQueryBuilder('consumable');
    queryBuilder.where('consumable.tenantId = :tenantId', { tenantId });
    queryBuilder.andWhere('consumable.isDeleted = :isDeleted', { isDeleted: false });

    if (filter?.category) {
      queryBuilder.andWhere('consumable.category = :category', { category: filter.category });
    }

    if (filter?.status) {
      queryBuilder.andWhere('consumable.status = :status', { status: filter.status });
    }

    if (filter?.supplierId) {
      queryBuilder.andWhere('consumable.supplierId = :supplierId', { supplierId: filter.supplierId });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('consumable.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(consumable.name ILIKE :search OR consumable.code ILIKE :search OR consumable.brand ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    queryBuilder.orderBy(`consumable.${sortBy}`, sortOrder);
    queryBuilder.skip((page - 1) * limit);
    queryBuilder.take(limit);

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
