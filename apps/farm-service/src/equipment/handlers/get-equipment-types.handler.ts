/**
 * Get Equipment Types Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetEquipmentTypesQuery } from '../queries/get-equipment-types.query';
import { EquipmentType } from '../entities/equipment-type.entity';

@QueryHandler(GetEquipmentTypesQuery)
export class GetEquipmentTypesHandler implements IQueryHandler<GetEquipmentTypesQuery> {
  constructor(
    @InjectRepository(EquipmentType)
    private readonly equipmentTypeRepository: Repository<EquipmentType>,
  ) {}

  async execute(query: GetEquipmentTypesQuery): Promise<EquipmentType[]> {
    const { filter } = query;

    const queryBuilder = this.equipmentTypeRepository.createQueryBuilder('equipmentType');

    if (filter?.category) {
      queryBuilder.where('equipmentType.category = :category', { category: filter.category });
    }

    if (filter?.isActive !== undefined) {
      queryBuilder.andWhere('equipmentType.isActive = :isActive', { isActive: filter.isActive });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(equipmentType.name ILIKE :search OR equipmentType.code ILIKE :search)',
        { search: `%${filter.search}%` }
      );
    }

    queryBuilder.orderBy('equipmentType.category', 'ASC');
    queryBuilder.addOrderBy('equipmentType.name', 'ASC');

    return queryBuilder.getMany();
  }
}
