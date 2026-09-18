/**
 * Water-quality farm-AI read-only NATS responder (PR-3, Water & Health
 * specialist). Five `request.farm.ai.*` subjects, each backed EXCLUSIVELY by
 * the module's existing tenant-scoped CQRS query handlers via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_SUBJECTS,
  FARM_AI_QUERY_LIMITS,
  isCriticalWaterQualityRequest,
  isSystemWqStatsRequest,
  isTankWqStatsRequest,
  isWaterQualityHistoryRequest,
  isWqThresholdsRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { GetSystemWaterQualityStatisticsQuery } from '../queries/get-system-water-quality-statistics.query';
import { GetTankWaterQualityStatisticsQuery } from '../queries/get-tank-water-quality-statistics.query';
import { GetWaterQualityChartQuery } from '../queries/get-water-quality-chart.query';
import { ListCriticalWaterQualityQuery } from '../queries/list-critical-water-quality.query';
import { ListParameterConfigsQuery } from '../queries/list-parameter-configs.query';
import { WaterQualityStatsResult } from '../query-handlers/water-quality-stats.result';
import {
  CriticalWaterQualityDto,
  WqMeasurementPointDto,
  WqStatsDto,
  WqThresholdDto,
  projectCriticalWaterQuality,
  projectWaterQualityMeasurement,
  projectWaterQualityStats,
  projectWaterQualityThreshold,
} from './projections';

@Controller()
export class WaterQualityAiQueryResponder {
  private readonly logger = new Logger(WaterQualityAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS)
  async tankStats(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<WqStatsDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isTankWqStatsRequest,
      async (req) =>
        projectWaterQualityStats(
          await this.queryBus.execute<
            GetTankWaterQualityStatisticsQuery,
            WaterQualityStatsResult
          >(
            new GetTankWaterQualityStatisticsQuery(
              req.tenantId,
              req.tankId,
              req.days ?? 7,
            ),
          ),
          req.days ?? 7,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_SYSTEM_STATS)
  async systemStats(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<WqStatsDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isSystemWqStatsRequest,
      async (req) =>
        projectWaterQualityStats(
          await this.queryBus.execute<
            GetSystemWaterQualityStatisticsQuery,
            WaterQualityStatsResult
          >(
            new GetSystemWaterQualityStatisticsQuery(
              req.tenantId,
              req.systemId,
              req.days ?? 7,
            ),
          ),
          req.days ?? 7,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_HISTORY)
  async history(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<WqMeasurementPointDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isWaterQualityHistoryRequest,
      async (req) =>
        toBoundedList(
          await this.queryBus.execute<GetWaterQualityChartQuery, WaterQualityMeasurement[]>(
            new GetWaterQualityChartQuery(
              req.tenantId,
              req.tankId,
              new Date(req.fromDate),
              new Date(req.toDate),
            ),
          ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectWaterQualityMeasurement,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL)
  async critical(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<CriticalWaterQualityDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isCriticalWaterQualityRequest,
      async (req) =>
        toBoundedList(
          await this.queryBus.execute<ListCriticalWaterQualityQuery, WaterQualityMeasurement[]>(
            new ListCriticalWaterQualityQuery(req.tenantId),
          ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectCriticalWaterQuality,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS)
  async thresholds(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<WqThresholdDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isWqThresholdsRequest,
      async (req) =>
        toBoundedList(
          // ParameterConfigFilter has NO speciesId field — the query runs
          // unfiltered and the species override is resolved in the projection.
          await this.queryBus.execute<
            ListParameterConfigsQuery,
            WaterQualityParameterConfig[]
          >(new ListParameterConfigsQuery(req.tenantId)),
          clampListLimit(undefined, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          (config) => projectWaterQualityThreshold(config, req.speciesId),
        ),
    );
  }
}
