/**
 * List Harvest Plans (filtered, paginated) Query Handler — fail-closed tenant
 * boundary. Reuses HarvestPlanService.applyFilters (static) as the single
 * filter SSoT so the WHERE logic is not duplicated.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HarvestPlan } from '../entities/harvest-plan.entity';
import { HarvestPlanService } from '../services/harvest-plan.service';
import { ListHarvestPlansQuery } from '../queries/list-harvest-plans.query';

@QueryHandler(ListHarvestPlansQuery)
export class ListHarvestPlansHandler implements IQueryHandler<ListHarvestPlansQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListHarvestPlansQuery): Promise<IStandardPaginatedResult<HarvestPlan>> {
    const { tenantId, filter } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(HarvestPlan, 'hp')
        .where('hp.tenantId = :tenantId', { tenantId });

      HarvestPlanService.applyFilters(qb, filter);

      const total = await qb.getCount();

      const limit = filter?.limit ?? 50;
      const offset = filter?.offset ?? 0;
      qb.skip(offset).take(limit);

      const sortBy = filter?.sortBy ?? 'plannedDate';
      const sortDir = filter?.sortDirection ?? 'ASC';
      const validSortFields = ['plannedDate', 'status', 'estimatedWeight', 'createdAt', 'updatedAt'];
      const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'plannedDate';
      qb.orderBy(`hp.${safeSortBy}`, sortDir);

      const items = await qb.getMany();
      const page = Math.floor(offset / limit) + 1;
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
