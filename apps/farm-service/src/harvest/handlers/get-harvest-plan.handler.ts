/**
 * Get Harvest Plan (by id) Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-074 / FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HarvestPlan } from '../entities/harvest-plan.entity';
import { GetHarvestPlanQuery } from '../queries/get-harvest-plan.query';

@QueryHandler(GetHarvestPlanQuery)
export class GetHarvestPlanHandler implements IQueryHandler<GetHarvestPlanQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHarvestPlanQuery): Promise<HarvestPlan | null> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(HarvestPlan, { where: { id, tenantId } }),
    );
  }
}
