/**
 * List Chemicals Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListChemicalsQuery } from '../queries/list-chemicals.query';
import { Chemical } from '../entities/chemical.entity';
import { ChemicalSite } from '../entities/chemical-site.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListChemicalsQuery)
export class ListChemicalsHandler implements IQueryHandler<ListChemicalsQuery> {
  constructor(
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
  ) {}

  async execute(query: ListChemicalsQuery): Promise<PaginatedResult<Chemical>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.chemicalRepository.createQueryBuilder('chemical');
    queryBuilder.where('chemical.tenantId = :tenantId', { tenantId });
    // DEFAULT: Only return non-deleted chemicals
    queryBuilder.andWhere('chemical.isDeleted = :isDeleted', { isDeleted: false });

    if (filter?.type) {
      queryBuilder.andWhere('chemical.type = :type', { type: filter.type });
    }

    if (filter?.status) {
      queryBuilder.andWhere('chemical.status = :status', { status: filter.status });
    }

    if (filter?.supplierId) {
      queryBuilder.andWhere('chemical.supplierId = :supplierId', { supplierId: filter.supplierId });
    }

    if (filter?.siteId) {
      queryBuilder.innerJoin(
        ChemicalSite,
        'chemicalSite',
        'chemicalSite.chemicalId = chemical.id AND chemicalSite.tenantId = :tenantId',
        { tenantId }
      );
      queryBuilder.andWhere('chemicalSite.siteId = :siteId', { siteId: filter.siteId });
      queryBuilder.andWhere('chemicalSite.isApproved = true');
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('chemical.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(chemical.name ILIKE :search OR chemical.code ILIKE :search OR chemical.activeIngredient ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting
    queryBuilder.orderBy(`chemical.${sortBy}`, sortOrder);

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
