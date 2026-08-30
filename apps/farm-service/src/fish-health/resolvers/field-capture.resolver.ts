/**
 * Field-Capture Resolver — GraphQL surface for the regulatory operational
 * records: lice counts, treatment applications, welfare assessments and
 * escape incidents. These are the source tables the report assemblers read;
 * the report forms never accept this data directly (corrections flow here).
 *
 * @module FishHealth
 */
import { Logger, UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { QueryBus } from '@platform/cqrs';

import { EscapeIncident, EscapeIncidentStatus } from '../entities/escape-incident.entity';
import { LiceCount } from '../entities/lice-count.entity';
import { TreatmentApplication } from '../entities/treatment-application.entity';
import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import {
  CloseEscapeIncidentInput,
  RecordEscapeIncidentInput,
  RecordLiceCountInput,
  RecordTreatmentApplicationInput,
  RecordWelfareAssessmentInput,
} from '../dto/field-capture.inputs';
import {
  IncidentMediaUploadResponse,
  RequestIncidentMediaUploadInput,
} from '../dto/incident-media.dto';
import { ListEscapeIncidentsQuery } from '../queries/list-escape-incidents.query';
import { ListLiceCountsQuery } from '../queries/list-lice-counts.query';
import { ListTreatmentApplicationsQuery } from '../queries/list-treatment-applications.query';
import { ListWelfareAssessmentsQuery } from '../queries/list-welfare-assessments.query';
import { EscapeIncidentService } from '../services/escape-incident.service';
import { IncidentMediaService } from '../services/incident-media.service';
import { LiceCountService } from '../services/lice-count.service';
import { TreatmentApplicationService } from '../services/treatment-application.service';
import { WelfareAssessmentService } from '../services/welfare-assessment.service';

@Resolver()
@UseGuards(TenantGuard)
export class FieldCaptureResolver {
  private readonly logger = new Logger(FieldCaptureResolver.name);

  constructor(
    private readonly liceCountService: LiceCountService,
    private readonly treatmentApplicationService: TreatmentApplicationService,
    private readonly welfareAssessmentService: WelfareAssessmentService,
    private readonly escapeIncidentService: EscapeIncidentService,
    private readonly incidentMediaService: IncidentMediaService,
    private readonly queryBus: QueryBus,
  ) {}

  // =========================================================================
  // QUERIES
  // =========================================================================

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [LiceCount], { description: 'Lice counts, optionally by site/tank and ISO week' })
  async liceCounts(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('tankId', { type: () => ID, nullable: true }) tankId?: string,
    @Args('reportingYear', { type: () => Int, nullable: true }) reportingYear?: number,
    @Args('reportingWeek', { type: () => Int, nullable: true }) reportingWeek?: number,
  ): Promise<LiceCount[]> {
    return this.queryBus.execute(
      new ListLiceCountsQuery(tenantId, siteId, tankId, reportingYear, reportingWeek),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [TreatmentApplication], {
    description: 'Treatment applications, optionally by site and applied-at window',
  })
  async treatmentApplications(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('fromDate', { nullable: true }) fromDate?: string,
    @Args('toDate', { nullable: true }) toDate?: string,
  ): Promise<TreatmentApplication[]> {
    return this.queryBus.execute(
      new ListTreatmentApplicationsQuery(tenantId, siteId, fromDate, toDate),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WelfareAssessment], {
    description: 'Welfare assessments, optionally by site/tank and date window',
  })
  async welfareAssessments(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('tankId', { type: () => ID, nullable: true }) tankId?: string,
    @Args('fromDate', { nullable: true }) fromDate?: string,
    @Args('toDate', { nullable: true }) toDate?: string,
  ): Promise<WelfareAssessment[]> {
    return this.queryBus.execute(
      new ListWelfareAssessmentsQuery(tenantId, siteId, tankId, fromDate, toDate),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [EscapeIncident], {
    description: 'Escape incidents, optionally by site and lifecycle status',
  })
  async escapeIncidents(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('status', { type: () => EscapeIncidentStatus, nullable: true })
    status?: EscapeIncidentStatus,
  ): Promise<EscapeIncident[]> {
    return this.queryBus.execute(new ListEscapeIncidentsQuery(tenantId, siteId, status));
  }

  // =========================================================================
  // MUTATIONS
  // =========================================================================

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => LiceCount, {
    description:
      'Record a lice count for a pen/date (upserts — re-recording the same pen/date corrects the row)',
  })
  async recordLiceCount(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: RecordLiceCountInput,
  ): Promise<LiceCount> {
    return this.liceCountService.record(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => TreatmentApplication, {
    description: 'Record an applied treatment (official Mattilsynet method/virkestoff values)',
  })
  async recordTreatmentApplication(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: RecordTreatmentApplicationInput,
  ): Promise<TreatmentApplication> {
    return this.treatmentApplicationService.record(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => WelfareAssessment, {
    description: 'Record a structured welfare assessment (0–3 scores over a fish sample)',
  })
  async recordWelfareAssessment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: RecordWelfareAssessmentInput,
  ): Promise<WelfareAssessment> {
    return this.welfareAssessmentService.record(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => EscapeIncident, {
    description: 'Record an operational escape incident (the rømming varsling assembles from it)',
  })
  async recordEscapeIncident(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: RecordEscapeIncidentInput,
  ): Promise<EscapeIncident> {
    this.logger.warn(`Escape incident being recorded for site ${input.siteId}`);
    return this.escapeIncidentService.record(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => IncidentMediaUploadResponse, {
    name: 'requestIncidentMediaUpload',
    description: 'Mint a presigned URL to upload an incident photo (escape/welfare/lice)',
  })
  async requestIncidentMediaUpload(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: RequestIncidentMediaUploadInput,
  ): Promise<IncidentMediaUploadResponse> {
    return this.incidentMediaService.requestUpload(tenantId, input);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => EscapeIncident, { description: 'Close an escape incident (recapture finished)' })
  async closeEscapeIncident(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: CloseEscapeIncidentInput,
  ): Promise<EscapeIncident> {
    return this.escapeIncidentService.close(tenantId, input, user.sub);
  }
}
