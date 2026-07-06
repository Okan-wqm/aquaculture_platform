/**
 * BiomassReportResolver
 *
 * Isolated from the main `regulatory.resolver.ts` (which owns settings
 * + Mattilsynet API submissions) so biomass-report concerns do not
 * pile into an already-large file. Phase 2.1 of the "kalan kör
 * noktalar" plan.
 *
 * Exposes:
 *   - `createBiomassReport(input)` — create-or-update-if-draft,
 *     optionally finalise with `input.submit=true`
 *   - `biomassReport(siteId, reportMonth, reportYear)` — single
 *     period lookup
 *   - `biomassReports(siteId, limit)` — period history for one site
 */
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';

import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';

import { BiomassReport } from './entities/biomass-report.entity';
import { BiomassReportService } from './services/biomass-report.service';
import { BiomassAltinnExportService } from './services/biomass-altinn-export.service';
import { BiomassAltinnExportOutput } from './dto/biomass-altinn-export.dto';
import { CreateBiomassReportInput } from './dto/create-biomass-report.input';
import { QueryBus } from '@platform/cqrs';
import { GetBiomassReportByPeriodQuery } from './queries/get-biomass-report-by-period.query';
import { ListBiomassReportsForSiteQuery } from './queries/list-biomass-reports-for-site.query';

interface UserContext {
  sub: string;
  email?: string;
  roles: string[];
}

@Resolver(() => BiomassReport)
@UseGuards(GqlAuthGuard)
export class BiomassReportResolver {
  private readonly logger = new Logger(BiomassReportResolver.name);

  constructor(
    private readonly biomassReportService: BiomassReportService,
    private readonly altinnExportService: BiomassAltinnExportService,
    private readonly queryBus: QueryBus,
  ) {}

  @Mutation(() => BiomassReport, {
    description:
      'Create or update (if draft) a monthly biomass report for a site. ' +
      'Pass submit=true to finalise — a SUBMITTED report becomes immutable.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createBiomassReport(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('input') input: CreateBiomassReportInput,
  ): Promise<BiomassReport> {
    this.logger.log(
      `createBiomassReport site=${input.siteId} period=${input.reportYear}-${input.reportMonth} submit=${input.submit ?? false}`,
    );
    return this.biomassReportService.createOrUpdate(tenantId, input, user.sub);
  }

  @Mutation(() => BiomassReport, {
    description: 'Mark a DRAFT biomass report READY for the manual Altinn (FD-0001) export.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async markBiomassReportReady(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BiomassReport> {
    return this.biomassReportService.markReady(tenantId, id, user.sub);
  }

  @Mutation(() => BiomassReport, {
    description: 'Reopen a READY biomass report back to DRAFT for editing.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async revertBiomassReportToDraft(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BiomassReport> {
    return this.biomassReportService.revertToDraft(tenantId, id);
  }

  @Mutation(() => BiomassReport, {
    description:
      'Confirm a READY biomass report was submitted to Fiskeridirektoratet via Altinn, ' +
      'recording the Altinn receipt reference (terminal, immutable).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async confirmBiomassReportSubmitted(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('altinnReference') altinnReference: string,
  ): Promise<BiomassReport> {
    return this.biomassReportService.confirmSubmitted(tenantId, id, altinnReference, user.sub);
  }

  @Query(() => BiomassReport, {
    nullable: true,
    description:
      'Lookup a biomass report by (siteId, reportMonth, reportYear).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async biomassReport(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('reportMonth', { type: () => Int }) reportMonth: number,
    @Args('reportYear', { type: () => Int }) reportYear: number,
  ): Promise<BiomassReport | null> {
    return this.queryBus.execute(
      new GetBiomassReportByPeriodQuery(tenantId, siteId, reportMonth, reportYear),
    );
  }

  @Query(() => BiomassAltinnExportOutput, {
    description:
      'Form-ordered FD-0001 export (CSV + printable) for a biomass report, to ' +
      'transcribe into the Altinn manual submission.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async biomassReportAltinnExport(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<BiomassAltinnExportOutput> {
    const report = await this.biomassReportService.getById(tenantId, id);
    return { ...this.altinnExportService.build(report), generatedAt: new Date() };
  }

  @Query(() => [BiomassReport], {
    description:
      'List biomass reports for a site, newest period first. `limit` is clamped to 120.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async biomassReports(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('limit', { type: () => Int, defaultValue: 24 }) limit: number,
  ): Promise<BiomassReport[]> {
    return this.queryBus.execute(
      new ListBiomassReportsForSiteQuery(tenantId, siteId, limit),
    );
  }
}
