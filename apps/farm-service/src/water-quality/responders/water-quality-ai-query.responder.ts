import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  clampListLimit,
  isCriticalWaterQualityRequest,
  isSystemWaterQualityStatsRequest,
  isTankWaterQualityStatsRequest,
  isWaterQualityHistoryRequest,
  isWaterQualityThresholdsRequest,
  type TenantBoundReply,
  type CriticalWaterQualityReply,
  type WaterQualityHistoryReply,
  type WaterQualityStatsReply,
  type WaterQualityThresholdsReply,
} from '@platform/event-contracts';
import { toBoundedList } from '../../common/nats/ai-query-responder';
import type { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { GetSystemWaterQualityStatisticsQuery } from '../queries/get-system-water-quality-statistics.query';
import { GetTankWaterQualityStatisticsQuery } from '../queries/get-tank-water-quality-statistics.query';
import { ListCriticalWaterQualityQuery } from '../queries/list-critical-water-quality.query';
import { ListWaterQualityQuery } from '../queries/list-water-quality.query';
import { ListParameterConfigsQuery } from '../queries/list-parameter-configs.query';
import type { WaterQualityStatsResult } from '../query-handlers/water-quality-stats.result';
import {
  projectCritical,
  projectMeasurement,
  projectStats,
  projectThreshold,
} from './ai-query.projections';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

/**
 * Water-quality read surface for the farm AI specialists (FARM-MEDIUM-328).
 * One @MessagePattern per contract subject; each dispatches the domain's own
 * query on the TenantScope the responder skeleton opened (FarmAiResponder) and projects
 * the result through ai-query.projections.
 */
@Controller()
export class WaterQualityAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS)
  getTankStats(@Payload() payload: unknown): Promise<TenantBoundReply<WaterQualityStatsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS,
        isRequest: isTankWaterQualityStatsRequest,
        handle: async (req, scope) => {
          const stats = await this.queryBus.execute<
            GetTankWaterQualityStatisticsQuery,
            WaterQualityStatsResult
          >(new GetTankWaterQualityStatisticsQuery(scope, req.tankId, req.days));
          return projectStats(req.tankId, req.days, stats);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS)
  getSystemStats(@Payload() payload: unknown): Promise<TenantBoundReply<WaterQualityStatsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS,
        isRequest: isSystemWaterQualityStatsRequest,
        handle: async (req, scope) => {
          const stats = await this.queryBus.execute<
            GetSystemWaterQualityStatisticsQuery,
            WaterQualityStatsResult
          >(new GetSystemWaterQualityStatisticsQuery(scope, req.systemId, req.days));
          return projectStats(req.systemId, req.days, stats);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY)
  getHistory(@Payload() payload: unknown): Promise<TenantBoundReply<WaterQualityHistoryReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.WQ_HISTORY,
        isRequest: isWaterQualityHistoryRequest,
        handle: async (req, scope) => {
          // The paginated list query loads the FULL measurement (the chart
          // query selects a sparse column set without `parameters`, which the
          // projection reads), orders newest-first and bounds the read in the
          // database (`take`), and counts the window so `truncated` is exact.
          // `toDate` is a calendar day: include the whole of it.
          const limit = clampListLimit(req.limit);
          const page = await this.queryBus.execute<
            ListWaterQualityQuery,
            IStandardPaginatedResult<WaterQualityMeasurement>
          >(
            new ListWaterQualityQuery(scope, {
              tankId: req.tankId,
              fromDate: new Date(req.fromDate),
              toDate: endOfUtcDay(req.toDate),
              limit,
              offset: 0,
            }),
          );
          return toBoundedList(page.items, limit, projectMeasurement, page.total);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL)
  listCritical(@Payload() payload: unknown): Promise<TenantBoundReply<CriticalWaterQualityReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL,
        isRequest: isCriticalWaterQualityRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<
            ListCriticalWaterQualityQuery,
            WaterQualityMeasurement[]
          >(new ListCriticalWaterQualityQuery(scope));
          return toBoundedList(rows, req.limit, projectCritical);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS)
  getThresholds(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<WaterQualityThresholdsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS,
        isRequest: isWaterQualityThresholdsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<
            ListParameterConfigsQuery,
            WaterQualityParameterConfig[]
          >(
            new ListParameterConfigsQuery(scope, {
              isActive: true,
              ...(req.group ? { group: req.group } : {}),
            }),
          );
          return toBoundedList(rows, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT, projectThreshold);
        },
      },
      payload,
    );
  }
}

/** The last instant of an ISO calendar day (UTC), so a `toDate` bound includes that day's readings. */
function endOfUtcDay(isoDate: string): Date {
  const end = new Date(isoDate);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}
