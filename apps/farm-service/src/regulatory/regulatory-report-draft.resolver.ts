/**
 * Regulatory Report Draft Resolver (RPT-003) — the operator's review workflow
 * over scheduler-assembled drafts, plus the per-type auto-submit opt-in.
 *
 * Reads: reportDrafts (optionally filtered), reportDeadlines (overdue/soon chips).
 * Lifecycle mutations: refreshReportDraft, saveReportDraftOverrides,
 * dismissReportDraft. Config: updateAutoSubmitPolicy (TENANT_ADMIN only —
 * turning on automated transmission is a tenant-admin decision).
 *
 * Draft SUBMISSION (approveAndSubmit + the auto-submit path) lands in the next
 * slice with the shared draft→wire mapper; this resolver deliberately stops at
 * review + config so the operator surface is usable first.
 */
import { Logger, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Args, Context, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Roles, Role } from '@aquaculture/backend-common/decorators';

import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { RegulatoryReportDraft } from './entities/regulatory-report-draft.entity';
import { RegulatoryReportDraftService } from './services/regulatory-report-draft.service';
import { RegulatoryDraftSubmissionService } from './services/regulatory-draft-submission.service';
import { RegulatorySettingsService } from './regulatory-settings.service';
import { ReportSubmissionResult } from './dto/regulatory-inputs.dto';
import {
  AutoSubmitPolicyEntry,
  ReportDeadlineOutput,
  ReportDraftFilterInput,
  SaveReportDraftOverridesInput,
  UpdateAutoSubmitPolicyInput,
} from './dto/regulatory-report-draft.dto';

interface GraphQLContext {
  req?: {
    user?: { tenantId?: string; sub?: string };
    tenantId?: string;
  };
}

@UseGuards(GqlAuthGuard)
@Resolver()
export class RegulatoryReportDraftResolver {
  private readonly logger = new Logger(RegulatoryReportDraftResolver.name);

  constructor(
    private readonly draftService: RegulatoryReportDraftService,
    private readonly draftSubmissionService: RegulatoryDraftSubmissionService,
    private readonly settingsService: RegulatorySettingsService,
  ) {}

  private getTenantId(ctx: GraphQLContext): string {
    const tenantId = ctx?.req?.user?.tenantId || ctx?.req?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant context required');
    }
    return tenantId;
  }

  private getUserId(ctx: GraphQLContext): string {
    const userId = ctx?.req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User context required');
    }
    return userId;
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => [RegulatoryReportDraft], {
    description: 'Scheduler-assembled regulatory report drafts awaiting review',
  })
  async reportDrafts(
    @Context() ctx: GraphQLContext,
    @Args('filter', { nullable: true }) filter?: ReportDraftFilterInput,
  ): Promise<RegulatoryReportDraft[]> {
    return this.draftService.listDrafts(this.getTenantId(ctx), filter);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => [ReportDeadlineOutput], {
    description: 'Upcoming/overdue regulatory report deadlines for the deadline view',
  })
  async reportDeadlines(@Context() ctx: GraphQLContext): Promise<ReportDeadlineOutput[]> {
    return this.draftService.listDeadlines(this.getTenantId(ctx), new Date());
  }

  // ==========================================================================
  // Mutations — draft lifecycle
  // ==========================================================================

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => RegulatoryReportDraft, {
    description: 'Re-assemble a draft from the current source records',
  })
  async refreshReportDraft(
    @Args('draftId', { type: () => ID }) draftId: string,
    @Context() ctx: GraphQLContext,
  ): Promise<RegulatoryReportDraft> {
    return this.draftService.refreshDraft(this.getTenantId(ctx), draftId);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => RegulatoryReportDraft, {
    description: 'Fill the blocking MANUAL_REQUIRED fields of a draft (RECORDS/SENSOR rejected)',
  })
  async saveReportDraftOverrides(
    @Args('input') input: SaveReportDraftOverridesInput,
    @Context() ctx: GraphQLContext,
  ): Promise<RegulatoryReportDraft> {
    return this.draftService.saveOverrides(this.getTenantId(ctx), input.draftId, input.overrides);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => RegulatoryReportDraft, {
    description: 'Dismiss a non-applicable regulatory report draft',
  })
  async dismissReportDraft(
    @Args('draftId', { type: () => ID }) draftId: string,
    @Context() ctx: GraphQLContext,
  ): Promise<RegulatoryReportDraft> {
    return this.draftService.dismissDraft(this.getTenantId(ctx), draftId);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ReportSubmissionResult, {
    description: 'Approve a READY draft and submit it to Mattilsynet',
  })
  async approveAndSubmitReportDraft(
    @Args('draftId', { type: () => ID }) draftId: string,
    @Context() ctx: GraphQLContext,
  ): Promise<ReportSubmissionResult> {
    return this.draftSubmissionService.approveAndSubmit(
      this.getTenantId(ctx),
      this.getUserId(ctx),
      draftId,
    );
  }

  // ==========================================================================
  // Mutations — auto-submit policy (TENANT_ADMIN)
  // ==========================================================================

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => [AutoSubmitPolicyEntry], {
    description: 'Toggle per-report-type automated submission (opt-in)',
  })
  async updateAutoSubmitPolicy(
    @Args('input') input: UpdateAutoSubmitPolicyInput,
    @Context() ctx: GraphQLContext,
  ): Promise<AutoSubmitPolicyEntry[]> {
    const saved = await this.settingsService.updateAutoSubmitPolicy(
      this.getTenantId(ctx),
      input.reportType,
      input.enabled,
    );
    return Object.entries(saved.autoSubmitPolicies ?? {}).map(([reportType, enabled]) => ({
      reportType,
      enabled,
    }));
  }
}
