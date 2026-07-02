/**
 * Get Harvest Plan (by plan code) Query Handler — fail-closed tenant boundary.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { HarvestPlan } from '../entities/harvest-plan.entity';
import { GetHarvestPlanByCodeQuery } from '../queries/get-harvest-plan-by-code.query';

@QueryHandler(GetHarvestPlanByCodeQuery)
export class GetHarvestPlanByCodeHandler implements IQueryHandler<GetHarvestPlanByCodeQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHarvestPlanByCodeQuery): Promise<HarvestPlan | null> {
    const { tenantId, planCode } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager.findOne(HarvestPlan, { where: { tenantId, planCode } }),
    );
  }
}
