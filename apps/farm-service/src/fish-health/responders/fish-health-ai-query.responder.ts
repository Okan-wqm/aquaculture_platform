import { Controller, Logger } from '@nestjs/common';
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
  type AiQueryReply,
  type FishHealthStatsReply,
  type HarvestEligibilityReply,
  type HealthEventsReply,
  type LiceCountsReply,
  type TreatmentApplicationsReply,
  type WelfareAssessmentsReply,
} from '@platform/event-contracts';
import { respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
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

const SEVERITY_BY_CODE: Readonly<Record<string, HealthSeverity>> = {
  minor: HealthSeverity.MINOR,
  moderate: HealthSeverity.MODERATE,
  severe: HealthSeverity.SEVERE,
  critical: HealthSeverity.CRITICAL,
};

/**
 * Fish-health read surface for the farm AI specialists (FARM-MEDIUM-328).
 * One @MessagePattern per contract subject; each dispatches the domain's own
 * query (tenant-pinned inside its handler via runInTenantRead) or the
 * harvest-eligibility service (runInTenantRead inside), then projects.
 */
@Controller()
export class FishHealthAiQueryResponder {
  private readonly logger = new Logger(FishHealthAiQueryResponder.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly harvestEligibility: BatchHarvestEligibilityService,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_STATS)
  getStats(@Payload() payload: unknown): Promise<AiQueryReply<FishHealthStatsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_STATS,
      payload,
      isFishHealthStatsRequest,
      async (req) => {
        const stats = await this.queryBus.execute<GetHealthEventStatsQuery, HealthEventStats>(
          new GetHealthEventStatsQuery(req.tenantId),
        );
        return projectStats(stats);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_EVENTS)
  listEvents(@Payload() payload: unknown): Promise<AiQueryReply<HealthEventsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_EVENTS,
      payload,
      isHealthEventsRequest,
      async (req) => {
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
        >(new ListHealthEventsQuery(req.tenantId, filter));
        return toBoundedList(page.items, req.limit, projectHealthEvent, page.total);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_CRITICAL)
  listCritical(@Payload() payload: unknown): Promise<AiQueryReply<HealthEventsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_CRITICAL,
      payload,
      isBoundedListRequest,
      async (req) => {
        const rows = await this.queryBus.execute<ListCriticalHealthEventsQuery, HealthEvent[]>(
          new ListCriticalHealthEventsQuery(req.tenantId),
        );
        return toBoundedList(rows, req.limit, projectHealthEvent);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS)
  listOverdueFollowUps(@Payload() payload: unknown): Promise<AiQueryReply<HealthEventsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS,
      payload,
      isBoundedListRequest,
      async (req) => {
        const rows = await this.queryBus.execute<ListOverdueFollowUpsQuery, HealthEvent[]>(
          new ListOverdueFollowUpsQuery(req.tenantId),
        );
        return toBoundedList(rows, req.limit, projectHealthEvent);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS)
  listLiceCounts(@Payload() payload: unknown): Promise<AiQueryReply<LiceCountsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS,
      payload,
      isLiceCountsRequest,
      async (req) => {
        const rows = await this.queryBus.execute<ListLiceCountsQuery, LiceCount[]>(
          new ListLiceCountsQuery(
            req.tenantId,
            req.siteId,
            req.tankId,
            req.reportingYear,
            req.reportingWeek,
          ),
        );
        return toBoundedList(rows, req.limit, projectLiceCount);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS)
  listTreatments(@Payload() payload: unknown): Promise<AiQueryReply<TreatmentApplicationsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS,
      payload,
      isTreatmentApplicationsRequest,
      async (req) => {
        const rows = await this.queryBus.execute<
          ListTreatmentApplicationsQuery,
          TreatmentApplication[]
        >(new ListTreatmentApplicationsQuery(req.tenantId, req.siteId, req.fromDate, req.toDate));
        return toBoundedList(rows, req.limit, projectTreatment);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_WELFARE)
  listWelfare(@Payload() payload: unknown): Promise<AiQueryReply<WelfareAssessmentsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_WELFARE,
      payload,
      isWelfareAssessmentsRequest,
      async (req) => {
        const rows = await this.queryBus.execute<ListWelfareAssessmentsQuery, WelfareAssessment[]>(
          new ListWelfareAssessmentsQuery(
            req.tenantId,
            req.siteId,
            req.tankId,
            req.fromDate,
            req.toDate,
          ),
        );
        return toBoundedList(rows, req.limit, projectWelfare);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY)
  checkHarvestEligibility(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<HarvestEligibilityReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY,
      payload,
      isHarvestEligibilityRequest,
      async (req) => {
        const result = await this.harvestEligibility.checkEligibility(
          req.tenantId,
          req.batchId,
          new Date(req.harvestDate),
        );
        return projectEligibility(req.batchId, req.harvestDate, result);
      },
    );
  }
}
