/**
 * Get SubEquipment Types Query Handler
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetSubEquipmentTypesQuery } from '../queries/get-sub-equipment-types.query';
import { SubEquipmentType } from '../entities/sub-equipment-type.entity';

@QueryHandler(GetSubEquipmentTypesQuery)
export class GetSubEquipmentTypesHandler implements IQueryHandler<GetSubEquipmentTypesQuery> {
  constructor(
    @InjectRepository(SubEquipmentType)
    private readonly subEquipmentTypeRepository: Repository<SubEquipmentType>,
  ) {}

  async execute(query: GetSubEquipmentTypesQuery): Promise<SubEquipmentType[]> {
    const { filter } = query;

    const queryBuilder = this.subEquipmentTypeRepository.createQueryBuilder('subEquipmentType');

    // Filter by compatibility with equipment type
    if (filter?.compatibleWithEquipmentType) {
      // compatibleEquipmentTypes is stored as a simple-array (comma-separated string)
      queryBuilder.andWhere(
        "subEquipmentType.compatibleEquipmentTypes LIKE :compatible",
        { compatible: `%${filter.compatibleWithEquipmentType}%` }
      );
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('subEquipmentType.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(subEquipmentType.name ILIKE :search OR subEquipmentType.code ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    // Order by sortOrder then name
    queryBuilder.orderBy('subEquipmentType.sortOrder', 'ASC');
    queryBuilder.addOrderBy('subEquipmentType.name', 'ASC');

    return queryBuilder.getMany();
  }
}
