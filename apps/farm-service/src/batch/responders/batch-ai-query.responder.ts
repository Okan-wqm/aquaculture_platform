/**
 * Batch/growth farm-AI read-only NATS responder (PR-4, Production
 * specialist). Five `request.farm.ai.*` subjects backed EXCLUSIVELY by the
 * batch and growth modules' existing tenant-scoped CQRS query handlers via
 * QueryBus — no direct DB access, no commands, PII-free projections (see
 * ./projections.ts). Envelope + validation plumbing lives in
 * common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isBatchPerformanceRequest,
  isGrowthAnalysisRequest,
  isGrowthMeasurementsRequest,
  isMortalityByCauseRequest,
  isTransfersSummaryRequest,
} from '@platform/event-contracts';
import { PaginatedQueryResult } from '@platform/cqrs';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { GetBatchPerformanceQuery, BatchPerformanceResult } from '../queries/get-batch-performance.query';
import { GetMortalityByCauseQuery, MortalityByCauseResult } from '../queries/get-mortality-by-cause.query';
import { GetTransfersSummaryQuery, TransfersSummaryResult } from '../queries/get-transfers-summary.query';
import { GetGrowthAnalysisQuery, GrowthAnalysisResult } from '../../growth/queries/get-growth-analysis.query';
import { GetGrowthMeasurementsQuery } from '../../growth/queries/get-growth-measurements.query';
import { GrowthMeasurement } from '../../growth/entities/growth-measurement.entity';
import {
  BatchPerformanceDto,
  GrowthAnalysisDto,
  GrowthMeasurementDto,
  MortalityByCauseDto,
  TransfersSummaryDto,
  projectBatchPerformance,
  projectGrowthAnalysis,
  projectGrowthMeasurement,
  projectMortalityByCause,
  projectTransfersSummary,
} from './projections';

@Controller()
export class BatchAiQueryResponder {
  private readonly logger = new Logger(BatchAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE)
  async performance(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<BatchPerformanceDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isBatchPerformanceRequest,
      async (req) =>
        projectBatchPerformance(
          await this.queryBus.execute<GetBatchPerformanceQuery, BatchPerformanceResult>(
            new GetBatchPerformanceQuery(req.tenantId, req.batchId),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS)
  async growthAnalysis(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<GrowthAnalysisDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isGrowthAnalysisRequest,
      async (req) =>
        projectGrowthAnalysis(
          await this.queryBus.execute<GetGrowthAnalysisQuery, GrowthAnalysisResult>(
            new GetGrowthAnalysisQuery(req.tenantId, req.batchId),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS)
  async growthMeasurements(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<AiQueryList<GrowthMeasurementDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isGrowthMeasurementsRequest,
      async (req) => {
        const limit = clampListLimit(
          req.limit,
          FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT,
        );
        const result = await this.queryBus.execute<
          GetGrowthMeasurementsQuery,
          PaginatedQueryResult<GrowthMeasurement>
        >(
          new GetGrowthMeasurementsQuery(
            req.tenantId,
            { batchId: req.batchId },
            1,
            limit,
          ),
        );
        return toBoundedList(
          result.data,
          limit,
          projectGrowthMeasurement,
          result.pagination.total,
        );
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE)
  async mortalityByCause(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<MortalityByCauseDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isMortalityByCauseRequest,
      async (req) =>
        projectMortalityByCause(
          await this.queryBus.execute<GetMortalityByCauseQuery, MortalityByCauseResult>(
            new GetMortalityByCauseQuery(
              req.tenantId,
              req.siteId,
              req.fromDate,
              req.toDate,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY)
  async transfersSummary(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<TransfersSummaryDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isTransfersSummaryRequest,
      async (req) =>
        projectTransfersSummary(
          await this.queryBus.execute<GetTransfersSummaryQuery, TransfersSummaryResult>(
            new GetTransfersSummaryQuery(
              req.tenantId,
              req.siteId,
              req.fromDate,
              req.toDate,
            ),
          ),
        ),
    );
  }
}
