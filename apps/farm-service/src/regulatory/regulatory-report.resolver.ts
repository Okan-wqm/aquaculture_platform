/**
 * RegulatoryReportResolver
 *
 * Read surface over the persisted Mattilsynet submissions in
 * `regulatory_reports` (FARM-HIGH-125). Isolated from
 * `regulatory.resolver.ts` (settings + submissions) and
 * `biomass-report.resolver.ts` (biomass drafts) following the same
 * file-per-concern split.
 *
 * Exposes:
 *   - `regulatoryReports(reportType, siteId?, limit, offset)` — submission
 *     history for one report type, newest first
 *   - `regulatoryReport(id)` — single submission incl. full payload
 *   - `regulatoryReportSummary(siteId?)` — per-type status counts + last
 *     submission timestamp (Reports page badges)
 */
import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';

import { CurrentTenant, Role, Roles } from '@aquaculture/backend-common/decorators';
import { QueryBus } from '@platform/cqrs';

import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import {
  RegulatoryReport,
  RegulatoryReportType,
} from './entities/regulatory-report.entity';
import { RegulatoryReportTypeSummary } from './dto/regulatory-report-summary.dto';
import { ListRegulatoryReportsQuery } from './queries/list-regulatory-reports.query';
import { GetRegulatoryReportQuery } from './queries/get-regulatory-report.query';
import { GetRegulatoryReportSummaryQuery } from './queries/get-regulatory-report-summary.query';

@Resolver(() => RegulatoryReport)
@UseGuards(GqlAuthGuard)
export class RegulatoryReportResolver {
  constructor(private readonly queryBus: QueryBus) {}

  @Query(() => [RegulatoryReport], {
    description:
      'List persisted regulatory report submissions for one report type, newest first. `limit` is clamped to 200.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async regulatoryReports(
    @CurrentTenant() tenantId: string,
    @Args('reportType', { type: () => RegulatoryReportType }) reportType: RegulatoryReportType,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit?: number,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset?: number,
  ): Promise<RegulatoryReport[]> {
    return this.queryBus.execute(
      new ListRegulatoryReportsQuery(tenantId, reportType, siteId, limit ?? 50, offset ?? 0),
    );
  }

  @Query(() => RegulatoryReport, {
    nullable: true,
    description: 'Fetch one persisted regulatory report submission (includes the full payload).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async regulatoryReport(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<RegulatoryReport | null> {
    return this.queryBus.execute(new GetRegulatoryReportQuery(tenantId, id));
  }

  @Query(() => [RegulatoryReportTypeSummary], {
    description:
      'Per-report-type submission summary: status counts + most recent submission timestamp.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async regulatoryReportSummary(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
  ): Promise<RegulatoryReportTypeSummary[]> {
    return this.queryBus.execute(new GetRegulatoryReportSummaryQuery(tenantId, siteId));
  }
}
