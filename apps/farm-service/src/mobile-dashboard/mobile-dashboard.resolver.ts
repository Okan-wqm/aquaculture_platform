import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { QueryBus } from '@platform/cqrs';
import { CurrentTenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { StockEventsSummary, TodaysDailyOpsCounts } from './dto/mobile-dashboard.dto';
import { GetTodaysDailyOpsCountsQuery } from './queries/get-todays-daily-ops-counts.query';
import { GetStockEventsSummaryQuery } from './queries/get-stock-events-summary.query';

@Resolver()
export class MobileDashboardResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => TodaysDailyOpsCounts, { name: 'todaysDailyOpsCounts' })
  async todaysDailyOpsCounts(
    @CurrentTenant() tenantId: string,
    // FARM-MEDIUM-056: optional device-local calendar day (strict YYYY-MM-DD)
    // so the dashboard counts and the phone agree on ONE named "today". When
    // absent, the service computes the day from FARM_DASHBOARD_TIME_ZONE.
    // tenantId is still sourced from @CurrentTenant (unchanged) — clientDate
    // only selects a day within the caller's OWN tenant.
    @Args('clientDate', { type: () => String, nullable: true }) clientDate?: string,
  ): Promise<TodaysDailyOpsCounts> {
    return this.queryBus.execute(
      new GetTodaysDailyOpsCountsQuery(tenantId, clientDate ?? undefined),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => StockEventsSummary, { name: 'stockEventsSummary' })
  async stockEventsSummary(
    @CurrentTenant() tenantId: string,
    @Args('daysBack', { type: () => Int, nullable: true, defaultValue: 7 }) daysBack?: number,
  ): Promise<StockEventsSummary> {
    return this.queryBus.execute(new GetStockEventsSummaryQuery(tenantId, daysBack ?? 7));
  }
}
