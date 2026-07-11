/**
 * List Slaughter Facilities Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { SlaughterFacility } from '../entities/slaughter-facility.entity';
import { ListSlaughterFacilitiesQuery } from '../queries/list-slaughter-facilities.query';

@QueryHandler(ListSlaughterFacilitiesQuery)
export class ListSlaughterFacilitiesHandler implements IQueryHandler<ListSlaughterFacilitiesQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListSlaughterFacilitiesQuery): Promise<SlaughterFacility[]> {
    const { tenantId, includeInactive } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(SlaughterFacility, 'sf')
        .where('sf.tenantId = :tenantId', { tenantId });

      if (!includeInactive) qb.andWhere('sf.isActive = true');

      return qb.orderBy('sf.isDefault', 'DESC').addOrderBy('sf.name', 'ASC').getMany();
    });
  }
}
