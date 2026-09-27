import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus, type PaginatedQueryResult } from '@platform/cqrs';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isDailyFeedingPlanRequest,
  isFeedingProtocolsRequest,
  isFeedingSummaryRequest,
  isSiteWindowRequest,
  toEventIso,
  type AiQueryReply,
  type DailyFeedingPlanReply,
  type FeedingProtocolDto,
  type FeedingProtocolsReply,
  type FeedingSummaryReply,
  type SiteFeedConsumptionReply,
} from '@platform/event-contracts';
import { numberOrNull, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import type { FeedingProtocol } from '../../feed/entities/feeding-protocol.entity';
import { ListFeedingProtocolsQuery } from '../../feed/queries/list-feeding-protocols.query';
import {
  GetDailyFeedingPlanQuery,
  type DailyFeedingPlanResult,
} from '../queries/get-daily-feeding-plan.query';
import {
  GetFeedingSummaryQuery,
  type FeedingSummaryResult,
} from '../queries/get-feeding-summary.query';
import {
  GetSiteFeedConsumptionQuery,
  type SiteFeedConsumptionResult,
} from '../queries/get-site-feed-consumption.query';

const DAILY_TREND_CAP = 31;

export function projectDailyPlan(result: DailyFeedingPlanResult): DailyFeedingPlanReply {
  const cap = FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT;
  return {
    date: toEventIso(result.date),
    siteId: result.siteId,
    totalPlannedKg: result.totalPlannedKg,
    totalActualKg: result.totalActualKg,
    completionPct: result.completionPercent,
    plannedFeedings: result.plannedFeedings.slice(0, cap).map((f) => ({
      batchId: f.batchId,
      batchCode: f.batchCode,
      tankId: f.tankId ?? null,
      tankCode: f.tankCode ?? null,
      feedId: f.feedId,
      feedName: f.feedName,
      plannedAmountKg: f.plannedAmountKg,
      actualAmountKg: f.actualAmountKg,
      mealsPlanned: f.mealsPlanned,
      mealsCompleted: f.mealsCompleted,
      isComplete: f.isComplete,
    })),
    truncated: result.plannedFeedings.length > cap,
  };
}

export function projectSummary(result: FeedingSummaryResult): FeedingSummaryReply {
  return {
    entityId: result.entityId,
    entityType: result.entityType,
    entityName: result.entityName,
    startDate: toEventIso(result.startDate),
    endDate: toEventIso(result.endDate),
    totalFeedingsCount: result.totalFeedingsCount,
    totalPlannedKg: result.totalPlannedKg,
    totalActualKg: result.totalActualKg,
    totalVarianceKg: result.totalVarianceKg,
    totalWasteKg: result.totalWasteKg,
    totalFeedCost: result.totalFeedCost,
    avgDailyFeedingKg: result.avgDailyFeedingKg,
    avgVariancePct: result.avgVariancePercent,
    appetiteDistribution: { ...result.appetiteDistribution },
    feedTypeDistribution: result.feedTypeDistribution.map((f) => ({
      feedId: f.feedId,
      feedName: f.feedName,
      totalKg: f.totalKg,
      pct: f.percentage,
      cost: f.cost,
    })),
    dailyTrend: result.dailyTrend.slice(-DAILY_TREND_CAP).map((d) => ({
      date: d.date,
      plannedKg: d.plannedKg,
      actualKg: d.actualKg,
      variancePct: d.variancePercent,
    })),
    dailyTrendTruncated: result.dailyTrend.length > DAILY_TREND_CAP,
  };
}

export function projectConsumption(
  siteId: string,
  fromDate: string,
  toDate: string,
  result: SiteFeedConsumptionResult,
): SiteFeedConsumptionReply {
  return {
    siteId,
    fromDate,
    toDate,
    totalKg: Number(result.totalKg),
    recordCount: result.recordCount,
    byFeedType: result.byFeedType.map((f) => ({
      feedName: f.feedName,
      brandName: f.brandName ?? null,
      quantityKg: Number(f.quantityKg),
    })),
  };
}

export function projectProtocol(row: FeedingProtocol): FeedingProtocolDto {
  return {
    id: row.id,
    name: row.name,
    species: row.species,
    stage: row.stage,
    feedId: row.feedId ?? null,
    targetFcr: numberOrNull(row.targetFcr),
    minDissolvedOxygenMgL: numberOrNull(row.minDissolvedOxygen),
    isActive: row.isActive,
    isDefault: row.isDefault,
  };
}

/** Feeding read surface for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class FeedingAiQueryResponder {
  private readonly logger = new Logger(FeedingAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEEDING_DAILY_PLAN)
  getDailyPlan(@Payload() payload: unknown): Promise<AiQueryReply<DailyFeedingPlanReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FEEDING_DAILY_PLAN,
      payload,
      isDailyFeedingPlanRequest,
      async (req) => {
        const result = await this.queryBus.execute<
          GetDailyFeedingPlanQuery,
          DailyFeedingPlanResult
        >(
          new GetDailyFeedingPlanQuery(
            req.tenantId,
            req.siteId,
            new Date(req.date),
            req.departmentId,
          ),
        );
        return projectDailyPlan(result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY)
  getSummary(@Payload() payload: unknown): Promise<AiQueryReply<FeedingSummaryReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FEEDING_SUMMARY,
      payload,
      isFeedingSummaryRequest,
      async (req) => {
        const result = await this.queryBus.execute<GetFeedingSummaryQuery, FeedingSummaryResult>(
          new GetFeedingSummaryQuery(
            req.tenantId,
            req.entityType,
            req.entityId,
            req.fromDate ? new Date(req.fromDate) : undefined,
            req.toDate ? new Date(req.toDate) : undefined,
          ),
        );
        return projectSummary(result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEEDING_SITE_CONSUMPTION)
  getSiteConsumption(@Payload() payload: unknown): Promise<AiQueryReply<SiteFeedConsumptionReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FEEDING_SITE_CONSUMPTION,
      payload,
      isSiteWindowRequest,
      async (req) => {
        const result = await this.queryBus.execute<
          GetSiteFeedConsumptionQuery,
          SiteFeedConsumptionResult
        >(new GetSiteFeedConsumptionQuery(req.tenantId, req.siteId, req.fromDate, req.toDate));
        return projectConsumption(req.siteId, req.fromDate, req.toDate, result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS)
  listProtocols(@Payload() payload: unknown): Promise<AiQueryReply<FeedingProtocolsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS,
      payload,
      isFeedingProtocolsRequest,
      async (req) => {
        const page = await this.queryBus.execute<
          ListFeedingProtocolsQuery,
          PaginatedQueryResult<FeedingProtocol>
        >(
          new ListFeedingProtocolsQuery(
            req.tenantId,
            { isActive: true, ...(req.species ? { species: req.species } : {}) },
            { page: 1, limit: req.limit },
          ),
        );
        return toBoundedList(page.data, req.limit, projectProtocol, page.pagination.total);
      },
    );
  }
}
