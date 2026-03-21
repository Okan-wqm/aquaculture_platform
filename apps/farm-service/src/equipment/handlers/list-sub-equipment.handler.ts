/**
 * List SubEquipment Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListSubEquipmentQuery } from '../queries/list-sub-equipment.query';
import { SubEquipment } from '../entities/sub-equipment.entity';

@QueryHandler(ListSubEquipmentQuery)
export class ListSubEquipmentHandler implements IQueryHandler<ListSubEquipmentQuery> {
  constructor(
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
  ) {}

  async execute(query: ListSubEquipmentQuery): Promise<PaginatedQueryResult<SubEquipment>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 50;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.subEquipmentRepository.createQueryBuilder('subEquipment');
    queryBuilder.where('subEquipment.tenantId = :tenantId', { tenantId });

    // Join related entities
    queryBuilder.leftJoinAndSelect('subEquipment.subEquipmentType', 'subEquipmentType');
    queryBuilder.leftJoinAndSelect('subEquipment.parentEquipment', 'parentEquipment');
    queryBuilder.leftJoinAndSelect('parentEquipment.equipmentType', 'parentEquipmentType');

    // Apply filters
    if (filter?.parentEquipmentId) {
      queryBuilder.andWhere('subEquipment.parentEquipmentId = :parentEquipmentId', {
        parentEquipmentId: filter.parentEquipmentId,
      });
    }

    if (filter?.subEquipmentTypeId) {
      queryBuilder.andWhere('subEquipment.subEquipmentTypeId = :subEquipmentTypeId', {
        subEquipmentTypeId: filter.subEquipmentTypeId,
      });
    }

    if (filter?.status) {
      queryBuilder.andWhere('subEquipment.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('subEquipment.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(subEquipment.name ILIKE :search OR subEquipment.code ILIKE :search OR subEquipment.serialNumber ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting with allowlist to prevent SQL injection
    const validSortFields = ['name', 'code', 'status', 'serialNumber', 'createdAt', 'updatedAt'];
    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    queryBuilder.orderBy(`subEquipment.${safeSortBy}`, sortOrder);

    // Apply pagination
    queryBuilder.skip((page - 1) * limit);
    queryBuilder.take(limit);

    // Execute query
    const [items, total] = await queryBuilder.getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
