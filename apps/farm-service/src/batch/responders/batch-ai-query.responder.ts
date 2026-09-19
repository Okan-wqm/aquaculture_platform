import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isBatchPerformanceRequest,
  isSiteWindowRequest,
  type AiQueryReply,
  type BatchPerformanceReply,
  type MortalityByCauseReply,
  type TransfersSummaryReply,
} from '@platform/event-contracts';
import { isoOrNull, numberOrNull, respondAiQuery } from '../../common/nats/ai-query-responder';
import {
  GetBatchPerformanceQuery,
  type BatchPerformanceResult,
} from '../queries/get-batch-performance.query';
import {
  GetMortalityByCauseQuery,
  type MortalityByCauseResult,
} from '../queries/get-mortality-by-cause.query';
import {
  GetTransfersSummaryQuery,
  type TransfersSummaryResult,
} from '../queries/get-transfers-summary.query';

export function projectPerformance(result: BatchPerformanceResult): BatchPerformanceReply {
  return {
    batchId: result.batchId,
    batchNumber: result.batchNumber,
    speciesName: result.speciesName,
    initialQuantity: result.initialQuantity,
    currentQuantity: result.currentQuantity,
    initialBiomassKg: result.initialBiomassKg,
    currentBiomassKg: result.currentBiomassKg,
    initialAvgWeightG: result.initialAvgWeightG,
    currentAvgWeightG: result.currentAvgWeightG,
    weightGainG: result.weightGainG,
    weightGainPct: result.weightGainPercent,
    totalMortality: result.totalMortality,
    mortalityRatePct: result.mortalityRate,
    survivalRatePct: result.survivalRate,
    cullCount: result.cullCount,
    fcr: { ...result.fcr },
    sgr: result.sgr,
    daysInProduction: result.daysInProduction,
    avgDailyGrowthG: result.avgDailyGrowthG,
    targetDailyGrowthG: result.targetDailyGrowthG,
    growthVariancePct: result.growthVariancePercent,
    totalFeedConsumedKg: result.totalFeedConsumedKg,
    totalFeedCost: result.totalFeedCost,
    avgDailyFeedKg: result.avgDailyFeedKg,
    totalCost: result.totalCost,
    costPerKg: result.costPerKg,
    costPerFish: result.costPerFish,
    projectedHarvestDate: isoOrNull(result.projectedHarvestDate),
    projectedHarvestWeightG: numberOrNull(result.projectedHarvestWeightG),
    daysToHarvest: numberOrNull(result.daysToHarvest),
    performanceIndex: result.performanceIndex,
    performanceStatus: result.performanceStatus,
  };
}

export function projectMortality(
  siteId: string,
  fromDate: string,
  toDate: string,
  result: MortalityByCauseResult,
): MortalityByCauseReply {
  const total = result.totalCount;
  return {
    siteId,
    fromDate,
    toDate,
    totalCount: total,
    recordCount: result.recordCount,
    byCause: result.byCause.map((c) => ({
      cause: c.cause,
      count: c.count,
      pct: total > 0 ? Math.round((c.count / total) * 1000) / 10 : 0,
    })),
  };
}

export function projectTransfers(
  siteId: string,
  fromDate: string,
  toDate: string,
  result: TransfersSummaryResult,
): TransfersSummaryReply {
  const cap = FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT;
  const inbound = result.records.filter((r) => r.direction === 'IN');
  const outbound = result.records.filter((r) => r.direction === 'OUT');
  const sum = (
    rows: readonly { fishCount: number; biomassKg: number }[],
    key: 'fishCount' | 'biomassKg',
  ): number => rows.reduce((acc, r) => acc + Number(r[key]), 0);
  return {
    siteId,
    fromDate,
    toDate,
    recordCount: result.recordCount,
    totalInCount: sum(inbound, 'fishCount'),
    totalInBiomassKg: sum(inbound, 'biomassKg'),
    totalOutCount: sum(outbound, 'fishCount'),
    totalOutBiomassKg: sum(outbound, 'biomassKg'),
    records: result.records.slice(0, cap).map((r) => ({
      date: r.date,
      direction: r.direction,
      speciesCode: r.speciesCode,
      fishCount: Number(r.fishCount),
      biomassKg: Number(r.biomassKg),
    })),
    truncated: result.records.length > cap,
  };
}

/** Batch read surface for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class BatchAiQueryResponder {
  private readonly logger = new Logger(BatchAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE)
  getPerformance(@Payload() payload: unknown): Promise<AiQueryReply<BatchPerformanceReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.BATCH_PERFORMANCE,
      payload,
      isBatchPerformanceRequest,
      async (req) => {
        const result = await this.queryBus.execute<
          GetBatchPerformanceQuery,
          BatchPerformanceResult
        >(new GetBatchPerformanceQuery(req.tenantId, req.batchId));
        return projectPerformance(result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE)
  getMortalityByCause(@Payload() payload: unknown): Promise<AiQueryReply<MortalityByCauseReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.BATCH_MORTALITY_BY_CAUSE,
      payload,
      isSiteWindowRequest,
      async (req) => {
        const result = await this.queryBus.execute<
          GetMortalityByCauseQuery,
          MortalityByCauseResult
        >(new GetMortalityByCauseQuery(req.tenantId, req.siteId, req.fromDate, req.toDate));
        return projectMortality(req.siteId, req.fromDate, req.toDate, result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY)
  getTransfersSummary(@Payload() payload: unknown): Promise<AiQueryReply<TransfersSummaryReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.BATCH_TRANSFERS_SUMMARY,
      payload,
      isSiteWindowRequest,
      async (req) => {
        const result = await this.queryBus.execute<
          GetTransfersSummaryQuery,
          TransfersSummaryResult
        >(new GetTransfersSummaryQuery(req.tenantId, req.siteId, req.fromDate, req.toDate));
        return projectTransfers(req.siteId, req.fromDate, req.toDate, result);
      },
    );
  }
}
