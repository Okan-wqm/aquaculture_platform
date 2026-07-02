/**
 * List Spare Parts compatible with an equipment type Query Handler — fail-closed
 * tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SparePart } from '../entities/spare-part.entity';
import { ListSparePartsByEquipmentTypeQuery } from '../queries/list-spare-parts-by-equipment-type.query';

@QueryHandler(ListSparePartsByEquipmentTypeQuery)
export class ListSparePartsByEquipmentTypeHandler
  implements IQueryHandler<ListSparePartsByEquipmentTypeQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSparePartsByEquipmentTypeQuery): Promise<SparePart[]> {
    const { tenantId, equipmentTypeId } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(SparePart, 'sp')
        .where('sp.tenantId = :tenantId', { tenantId })
        .andWhere('sp.isActive = true')
        .andWhere(
          '(sp.equipmentTypeId = :equipmentTypeId OR :equipmentTypeId = ANY(sp.compatibleEquipmentTypes))',
          { equipmentTypeId },
        )
        .orderBy('sp.name', 'ASC')
        .getMany(),
    );
  }
}
