/**
 * List Equipment Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListEquipmentQuery } from '../queries/list-equipment.query';
import { Equipment } from '../entities/equipment.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@QueryHandler(ListEquipmentQuery)
export class ListEquipmentHandler implements IQueryHandler<ListEquipmentQuery> {
  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(query: ListEquipmentQuery): Promise<PaginatedResult<Equipment>> {
    const { tenantId, filter, pagination } = query;

    const page = pagination?.page || 1;
    // Support both 'limit' and 'pageSize' for compatibility with different schema versions
    // Default to 200 items when no pagination is provided (for tank list views)
    const limit = (pagination as any)?.limit || (pagination as any)?.pageSize || 200;
    const sortBy = (pagination as any)?.sortBy || 'createdAt';
    const sortOrder = (pagination as any)?.sortOrder || 'DESC';

    // Build query
    const queryBuilder = this.equipmentRepository.createQueryBuilder('equipment');
    queryBuilder.where('equipment.tenantId = :tenantId', { tenantId });
    // DEFAULT: Only return non-deleted equipment
    queryBuilder.andWhere('equipment.isDeleted = :isDeleted', { isDeleted: false });

    // Join related entities
    queryBuilder.leftJoinAndSelect('equipment.department', 'department');
    queryBuilder.leftJoinAndSelect('equipment.equipmentType', 'equipmentType');
    queryBuilder.leftJoinAndSelect('equipment.equipmentSystems', 'equipmentSystems');
    queryBuilder.leftJoinAndSelect('equipmentSystems.system', 'system');
    // Join parent/child equipment for hierarchy display
    queryBuilder.leftJoinAndSelect('equipment.parentEquipment', 'parentEquipment');
    queryBuilder.leftJoinAndSelect('parentEquipment.equipmentType', 'parentEquipmentType');
    queryBuilder.leftJoinAndSelect('equipment.childEquipment', 'childEquipment');
    queryBuilder.leftJoinAndSelect('childEquipment.equipmentType', 'childEquipmentType');

    if (filter?.departmentId) {
      queryBuilder.andWhere('equipment.departmentId = :departmentId', { departmentId: filter.departmentId });
    }

    // Note: siteId is not a direct column on equipment - filter via department.siteId if needed
    if (filter?.siteId) {
      queryBuilder.andWhere('department.siteId = :siteId', { siteId: filter.siteId });
    }

    // Filter by systemId via junction table
    if (filter?.systemId) {
      queryBuilder.andWhere('equipmentSystems.systemId = :systemId', { systemId: filter.systemId });
    }

    if (filter?.parentEquipmentId) {
      queryBuilder.andWhere('equipment.parentEquipmentId = :parentEquipmentId', { parentEquipmentId: filter.parentEquipmentId });
    }

    // Root only filter - get equipment without parent
    if (filter?.rootOnly) {
      queryBuilder.andWhere('equipment.parentEquipmentId IS NULL');
    }

    if (filter?.equipmentTypeId) {
      queryBuilder.andWhere('equipment.equipmentTypeId = :equipmentTypeId', { equipmentTypeId: filter.equipmentTypeId });
    }

    if (filter?.status) {
      queryBuilder.andWhere('equipment.status = :status', { status: filter.status });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('equipment.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.hasWarranty) {
      queryBuilder.andWhere('equipment.warrantyEndDate > :now', { now: new Date() });
    }

    if (filter?.isVisibleInSensor !== undefined) {
      queryBuilder.andWhere('equipment.isVisibleInSensor = :isVisibleInSensor', { isVisibleInSensor: filter.isVisibleInSensor });
    }

    if (filter?.isTank !== undefined) {
      queryBuilder.andWhere('equipment.isTank = :isTank', { isTank: filter.isTank });
    }

    // Filter by equipment type categories (e.g., tank, pond, cage)
    if (filter?.categories && filter.categories.length > 0) {
      queryBuilder.andWhere('equipmentType.category IN (:...categories)', { categories: filter.categories });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(equipment.name ILIKE :search OR equipment.code ILIKE :search OR equipment.serialNumber ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Apply sorting
    queryBuilder.orderBy(`equipment.${sortBy}`, sortOrder);

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
