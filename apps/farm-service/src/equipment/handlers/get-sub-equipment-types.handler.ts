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

    // WHAT: exact element containment against the `text[]` column.
    // WHY: this filter used `LIKE '%<code>%'` against the comma-joined
    // simple-array serialisation, so a code that is a SUBSTRING of another code
    // matched wrongly — asking for the sub-types of 'valve' also returned every
    // sub-type compatible with 'inlet-valve', 'outlet-valve' and
    // 'backwash-valve'. The column is now a real array (see
    // SubEquipmentType.compatibleEquipmentTypes), and `@>` compares whole
    // elements, so the wrong answer is no longer expressible.
    if (filter?.compatibleWithEquipmentType) {
      queryBuilder.andWhere('subEquipmentType.compatibleEquipmentTypes @> :compatible', {
        compatible: [filter.compatibleWithEquipmentType],
      });
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
