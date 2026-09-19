import { Controller, Logger } from '@nestjs/common';
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
  type AiQueryReply,
  type CriticalWaterQualityReply,
  type WaterQualityHistoryReply,
  type WaterQualityStatsReply,
  type WaterQualityThresholdsReply,
} from '@platform/event-contracts';
import { respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
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

/**
 * Water-quality read surface for the farm AI specialists (FARM-MEDIUM-328).
 * One @MessagePattern per contract subject; each dispatches the domain's own
 * query (tenant-pinned inside its handler via runInTenantRead) and projects
 * the result through ai-query.projections.
 */
@Controller()
export class WaterQualityAiQueryResponder {
  private readonly logger = new Logger(WaterQualityAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS)
  getTankStats(@Payload() payload: unknown): Promise<AiQueryReply<WaterQualityStatsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS,
      payload,
      isTankWaterQualityStatsRequest,
      async (req) => {
        const stats = await this.queryBus.execute<
          GetTankWaterQualityStatisticsQuery,
          WaterQualityStatsResult
        >(new GetTankWaterQualityStatisticsQuery(req.tenantId, req.tankId, req.days));
        return projectStats(req.tankId, req.days, stats);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS)
  getSystemStats(@Payload() payload: unknown): Promise<AiQueryReply<WaterQualityStatsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS,
      payload,
      isSystemWaterQualityStatsRequest,
      async (req) => {
        const stats = await this.queryBus.execute<
          GetSystemWaterQualityStatisticsQuery,
          WaterQualityStatsResult
        >(new GetSystemWaterQualityStatisticsQuery(req.tenantId, req.systemId, req.days));
        return projectStats(req.systemId, req.days, stats);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY)
  getHistory(@Payload() payload: unknown): Promise<AiQueryReply<WaterQualityHistoryReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.WQ_HISTORY,
      payload,
      isWaterQualityHistoryRequest,
      async (req) => {
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
          new ListWaterQualityQuery(req.tenantId, {
            tankId: req.tankId,
            fromDate: new Date(req.fromDate),
            toDate: endOfUtcDay(req.toDate),
            limit,
            offset: 0,
          }),
        );
        return toBoundedList(page.items, limit, projectMeasurement, page.total);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL)
  listCritical(@Payload() payload: unknown): Promise<AiQueryReply<CriticalWaterQualityReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL,
      payload,
      isCriticalWaterQualityRequest,
      async (req) => {
        const rows = await this.queryBus.execute<
          ListCriticalWaterQualityQuery,
          WaterQualityMeasurement[]
        >(new ListCriticalWaterQualityQuery(req.tenantId));
        return toBoundedList(rows, req.limit, projectCritical);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS)
  getThresholds(@Payload() payload: unknown): Promise<AiQueryReply<WaterQualityThresholdsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS,
      payload,
      isWaterQualityThresholdsRequest,
      async (req) => {
        const rows = await this.queryBus.execute<
          ListParameterConfigsQuery,
          WaterQualityParameterConfig[]
        >(
          new ListParameterConfigsQuery(req.tenantId, {
            isActive: true,
            ...(req.group ? { group: req.group } : {}),
          }),
        );
        return toBoundedList(rows, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT, projectThreshold);
      },
    );
  }
}

/** The last instant of an ISO calendar day (UTC), so a `toDate` bound includes that day's readings. */
function endOfUtcDay(isoDate: string): Date {
  const end = new Date(isoDate);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}
