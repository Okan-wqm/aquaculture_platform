/**
 * Fish-health farm-AI read-only NATS responder (PR-3, Water & Health
 * specialist). Eight `request.farm.ai.*` subjects backed EXCLUSIVELY by the
 * module's existing tenant-scoped CQRS query handlers via QueryBus (and the
 * harvest-eligibility read service) — no direct DB access, no commands,
 * PII-free projections (see ./projections.ts).
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isBatchHarvestEligibilityRequest,
  isCriticalHealthEventsRequest,
  isFishHealthStatsRequest,
  isHealthEventsRequest,
  isLiceCountsRequest,
  isOverdueFollowUpsRequest,
  isTreatmentApplicationsRequest,
  isWelfareAssessmentsRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { HealthEvent } from '../entities/health-event.entity';
import { LiceCount } from '../entities/lice-count.entity';
import { TreatmentApplication } from '../entities/treatment-application.entity';
import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { HealthEventFilterInput } from '../dto/health-event-filter.input';
import { GetHealthEventStatsQuery } from '../queries/get-health-event-stats.query';
import { ListCriticalHealthEventsQuery } from '../queries/list-critical-health-events.query';
import { ListHealthEventsQuery } from '../queries/list-health-events.query';
import { ListLiceCountsQuery } from '../queries/list-lice-counts.query';
import { ListOverdueFollowUpsQuery } from '../queries/list-overdue-follow-ups.query';
import { ListTreatmentApplicationsQuery } from '../queries/list-treatment-applications.query';
import { ListWelfareAssessmentsQuery } from '../queries/list-welfare-assessments.query';
import { BatchHarvestEligibilityService } from '../services/batch-harvest-eligibility.service';
import { HealthEventStats } from '../services/health-event.service';
import {
  FishHealthStatsDto,
  HarvestEligibilityDto,
  HealthEventSummaryDto,
  LiceCountDto,
  TreatmentApplicationDto,
  WelfareAssessmentDto,
  projectFishHealthStats,
  projectHarvestEligibility,
  projectHealthEvent,
  projectLiceCount,
  projectTreatmentApplication,
  projectWelfareAssessment,
} from './projections';

@Controller()
export class FishHealthAiQueryResponder {
  private readonly logger = new Logger(FishHealthAiQueryResponder.name);

  constructor(
    private readonly queryBus: QueryBus,
    private readonly harvestEligibilityService: BatchHarvestEligibilityService,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_STATS)
  async stats(@Payload() payload: unknown): Promise<AiQueryReply<FishHealthStatsDto>> {
    return respondAiQuery(this.logger, payload, isFishHealthStatsRequest, async (req) =>
      projectFishHealthStats(
        await this.queryBus.execute<GetHealthEventStatsQuery, HealthEventStats>(
          new GetHealthEventStatsQuery(req.tenantId),
        ),
      ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_EVENTS)
  async events(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<HealthEventSummaryDto>>> {
    return respondAiQuery(this.logger, payload, isHealthEventsRequest, async (req) => {
      const limit = clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT);
      // ONLY filter fields the AI contract exposes are passed through — the
      // filter DTO is far wider (free-text search, reportedBy, …) and must
      // stay unreachable from the model surface.
      const filter: HealthEventFilterInput = {
        activeOnly: req.activeOnly ?? true,
        limit,
      };
      if (req.batchId !== undefined) filter.batchId = req.batchId;
      if (req.tankId !== undefined) filter.tankId = req.tankId;
      if (req.severity !== undefined) {
        // Guard already pinned the value to HealthSeverity's literal union —
        // the cast bridges the contract's string union to the enum type.
        filter.severity = req.severity as HealthEventFilterInput['severity'];
      }

      const result = await this.queryBus.execute<
        ListHealthEventsQuery,
        { items?: HealthEvent[]; total?: number }
      >(new ListHealthEventsQuery(req.tenantId, filter));
      const rows = result.items ?? [];
      return toBoundedList(rows, limit, projectHealthEvent, result.total);
    });
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_CRITICAL)
  async critical(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<HealthEventSummaryDto>>> {
    return respondAiQuery(this.logger, payload, isCriticalHealthEventsRequest, async (req) =>
      toBoundedList(
        await this.queryBus.execute<ListCriticalHealthEventsQuery, HealthEvent[]>(
          new ListCriticalHealthEventsQuery(req.tenantId),
        ),
        clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
        projectHealthEvent,
      ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_OVERDUE_FOLLOW_UPS)
  async overdueFollowUps(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<HealthEventSummaryDto>>> {
    return respondAiQuery(this.logger, payload, isOverdueFollowUpsRequest, async (req) =>
      toBoundedList(
        await this.queryBus.execute<ListOverdueFollowUpsQuery, HealthEvent[]>(
          new ListOverdueFollowUpsQuery(req.tenantId),
        ),
        clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
        projectHealthEvent,
      ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_LICE_COUNTS)
  async liceCounts(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<LiceCountDto>>> {
    return respondAiQuery(this.logger, payload, isLiceCountsRequest, async (req) =>
      toBoundedList(
        await this.queryBus.execute<ListLiceCountsQuery, LiceCount[]>(
          new ListLiceCountsQuery(
            req.tenantId,
            req.siteId,
            req.tankId,
            req.reportingYear,
            req.reportingWeek,
          ),
        ),
        clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
        projectLiceCount,
      ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_TREATMENTS)
  async treatments(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<TreatmentApplicationDto>>> {
    return respondAiQuery(this.logger, payload, isTreatmentApplicationsRequest, async (req) =>
      toBoundedList(
        await this.queryBus.execute<ListTreatmentApplicationsQuery, TreatmentApplication[]>(
          new ListTreatmentApplicationsQuery(req.tenantId, req.siteId, req.fromDate, req.toDate),
        ),
        clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
        projectTreatmentApplication,
      ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_WELFARE)
  async welfare(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<WelfareAssessmentDto>>> {
    return respondAiQuery(this.logger, payload, isWelfareAssessmentsRequest, async (req) =>
      toBoundedList(
        await this.queryBus.execute<ListWelfareAssessmentsQuery, WelfareAssessment[]>(
          new ListWelfareAssessmentsQuery(
            req.tenantId,
            req.siteId,
            req.tankId,
            req.fromDate,
            req.toDate,
          ),
        ),
        clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
        projectWelfareAssessment,
      ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FH_HARVEST_ELIGIBILITY)
  async harvestEligibility(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<HarvestEligibilityDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isBatchHarvestEligibilityRequest,
      async (req) =>
        projectHarvestEligibility(
          await this.harvestEligibilityService.checkEligibility(
            req.tenantId,
            req.batchId,
            new Date(req.harvestDate),
          ),
        ),
    );
  }
}
