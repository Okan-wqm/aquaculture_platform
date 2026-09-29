import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBoundedListRequest,
  isFishHealthStatsRequest,
  isHarvestEligibilityRequest,
  isHealthEventsRequest,
  isLiceCountsRequest,
  isTreatmentApplicationsRequest,
  isWelfareAssessmentsRequest,
  type TenantBoundReply,
  type FishHealthStatsReply,
  type HarvestEligibilityReply,
  type HealthEventsReply,
  type LiceCountsReply,
  type TreatmentApplicationsReply,
  type WelfareAssessmentsReply,
} from '@platform/event-contracts';
import { toBoundedList } from '../../common/nats/ai-query-responder';
import { HealthEventFilterInput } from '../dto/health-event-filter.input';
import { HealthSeverity, type HealthEvent } from '../entities/health-event.entity';
import type { LiceCount } from '../entities/lice-count.entity';
import type { TreatmentApplication } from '../entities/treatment-application.entity';
import type { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { GetHealthEventStatsQuery } from '../queries/get-health-event-stats.query';
import { ListCriticalHealthEventsQuery } from '../queries/list-critical-health-events.query';
import { ListHealthEventsQuery } from '../queries/list-health-events.query';
import { ListLiceCountsQuery } from '../queries/list-lice-counts.query';
import { ListOverdueFollowUpsQuery } from '../queries/list-overdue-follow-ups.query';
import { ListTreatmentApplicationsQuery } from '../queries/list-treatment-applications.query';
import { ListWelfareAssessmentsQuery } from '../queries/list-welfare-assessments.query';
import { BatchHarvestEligibilityService } from '../services/batch-harvest-eligibility.service';
import type { HealthEventStats } from '../services/health-event.service';
import {
  projectEligibility,
  projectHealthEvent,
  projectLiceCount,
  projectStats,
  projectTreatment,
  projectWelfare,
} from './ai-query.projections';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

const SEVERITY_BY_CODE: Readonly<Record<string, HealthSeverity>> = {
  minor: HealthSeverity.MINOR,
  moderate: HealthSeverity.MODERATE,
  severe: HealthSeverity.SEVERE,
  critical: HealthSeverity.CRITICAL,
};

/**
 * Fish-health read surface for the farm AI specialists (FARM-MEDIUM-328).
 * One @MessagePattern per contract subject; each dispatches the domain's own
 * query or the harvest-eligibility check on the TenantScope the responder
 * skeleton opened (FarmAiResponder), then projects.
 */
@Controller()
export class FishHealthAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
    private readonly harvestEligibility: BatchHarvestEligibilityService,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_STATS)
  getStats(@Payload() payload: unknown): Promise<TenantBoundReply<FishHealthStatsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_STATS,
        isRequest: isFishHealthStatsRequest,
        handle: async (req, scope) => {
          const stats = await this.queryBus.execute<GetHealthEventStatsQuery, HealthEventStats>(
            new GetHealthEventStatsQuery(scope),
          );
          return projectStats(stats);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_EVENTS)
  listEvents(@Payload() payload: unknown): Promise<TenantBoundReply<HealthEventsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_EVENTS,
        isRequest: isHealthEventsRequest,
        handle: async (req, scope) => {
          const filter = new HealthEventFilterInput();
          if (req.batchId) filter.batchId = req.batchId;
          if (req.tankId) filter.tankId = req.tankId;
          if (req.activeOnly) filter.activeOnly = true;
          if (req.severity) filter.severity = SEVERITY_BY_CODE[req.severity];
          filter.limit = req.limit;
          filter.offset = 0;
          const page = await this.queryBus.execute<
            ListHealthEventsQuery,
            IStandardPaginatedResult<HealthEvent>
          >(new ListHealthEventsQuery(scope, filter));
          return toBoundedList(page.items, req.limit, projectHealthEvent, page.total);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_CRITICAL)
  listCritical(@Payload() payload: unknown): Promise<TenantBoundReply<HealthEventsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_CRITICAL,
        isRequest: isBoundedListRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<ListCriticalHealthEventsQuery, HealthEvent[]>(
            new ListCriticalHealthEventsQuery(scope),
          );
          return toBoundedList(rows, req.limit, projectHealthEvent);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS)
  listOverdueFollowUps(@Payload() payload: unknown): Promise<TenantBoundReply<HealthEventsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS,
        isRequest: isBoundedListRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<ListOverdueFollowUpsQuery, HealthEvent[]>(
            new ListOverdueFollowUpsQuery(scope),
          );
          return toBoundedList(rows, req.limit, projectHealthEvent);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS)
  listLiceCounts(@Payload() payload: unknown): Promise<TenantBoundReply<LiceCountsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS,
        isRequest: isLiceCountsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<ListLiceCountsQuery, LiceCount[]>(
            new ListLiceCountsQuery(
              scope,
              req.siteId,
              req.tankId,
              req.reportingYear,
              req.reportingWeek,
            ),
          );
          return toBoundedList(rows, req.limit, projectLiceCount);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS)
  listTreatments(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<TreatmentApplicationsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS,
        isRequest: isTreatmentApplicationsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<
            ListTreatmentApplicationsQuery,
            TreatmentApplication[]
          >(new ListTreatmentApplicationsQuery(scope, req.siteId, req.fromDate, req.toDate));
          return toBoundedList(rows, req.limit, projectTreatment);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_WELFARE)
  listWelfare(@Payload() payload: unknown): Promise<TenantBoundReply<WelfareAssessmentsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_WELFARE,
        isRequest: isWelfareAssessmentsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<
            ListWelfareAssessmentsQuery,
            WelfareAssessment[]
          >(
            new ListWelfareAssessmentsQuery(
              scope,
              req.siteId,
              req.tankId,
              req.fromDate,
              req.toDate,
            ),
          );
          return toBoundedList(rows, req.limit, projectWelfare);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY)
  checkHarvestEligibility(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<HarvestEligibilityReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY,
        isRequest: isHarvestEligibilityRequest,
        handle: async (req, scope) => {
          const result = await this.harvestEligibility.checkEligibility(
            scope,
            req.batchId,
            new Date(req.harvestDate),
          );
          return projectEligibility(req.batchId, req.harvestDate, result);
        },
      },
      payload,
    );
  }
}
