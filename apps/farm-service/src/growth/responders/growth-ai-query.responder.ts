import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus, type PaginatedQueryResult } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBatchPerformanceRequest,
  isGrowthMeasurementsRequest,
  toEventIso,
  type AiQueryReply,
  type GrowthAnalysisReply,
  type GrowthMeasurementDto,
  type GrowthMeasurementsReply,
} from '@platform/event-contracts';
import {
  isoOrNull,
  numberOrNull,
  respondAiQuery,
  toBoundedList,
} from '../../common/nats/ai-query-responder';
import type { GrowthMeasurement } from '../entities/growth-measurement.entity';
import {
  GetGrowthAnalysisQuery,
  type GrowthAnalysisResult,
} from '../queries/get-growth-analysis.query';
import { GetGrowthMeasurementsQuery } from '../queries/get-growth-measurements.query';

/** Trend points kept in the reply — the model reasons over the recent curve, not the whole series. */
const GROWTH_TREND_CAP = 30;
const RECOMMENDATIONS_CAP = 10;

export function projectAnalysis(result: GrowthAnalysisResult): GrowthAnalysisReply {
  const trend = result.growthTrend.slice(-GROWTH_TREND_CAP);
  return {
    batchId: result.batchId,
    batchNumber: result.batchNumber,
    speciesName: result.speciesName,
    measurementCount: result.measurementCount,
    daysInProduction: result.daysInProduction,
    stockedDate: toEventIso(result.stockedDate),
    initialAvgWeightG: result.initialAvgWeightG,
    currentAvgWeightG: result.currentAvgWeightG,
    targetAvgWeightG: numberOrNull(result.targetAvgWeightG),
    avgDailyGrowthG: result.avgDailyGrowthG,
    targetDailyGrowthG: numberOrNull(result.targetDailyGrowthG),
    sgr: result.specificGrowthRate,
    currentBiomassKg: result.currentBiomassKg,
    biomassGainKg: result.biomassGainKg,
    cumulativeFcr: result.cumulativeFCR,
    targetFcr: result.targetFCR,
    fcrVariancePct: result.fcrVariancePercent,
    fcrTrend: result.fcrTrend,
    avgWeightCvPct: result.avgWeightCV,
    cvTrend: result.cvTrend,
    needsGrading: result.needsGrading,
    overallPerformance: result.overallPerformance,
    performanceIndex: result.performanceIndex,
    growthTrend: trend.map((p) => ({
      date: p.date,
      avgWeightG: p.avgWeightG,
      theoreticalWeightG: p.theoreticalWeightG,
      cvPct: p.cv,
      sgr: p.sgr,
    })),
    growthTrendTruncated: result.growthTrend.length > GROWTH_TREND_CAP,
    projectedHarvestDate: isoOrNull(result.projectedHarvestDate),
    projectedHarvestWeightG: numberOrNull(result.projectedHarvestWeightG),
    daysToHarvest: numberOrNull(result.daysToHarvest),
    recommendations: result.recommendations.slice(0, RECOMMENDATIONS_CAP).map((r) => ({
      priority: r.priority,
      type: r.type,
      description: r.description,
    })),
  };
}

export function projectMeasurement(row: GrowthMeasurement): GrowthMeasurementDto {
  return {
    id: row.id,
    measurementDate: toEventIso(row.measurementDate),
    measurementType: row.measurementType,
    sampleSize: Number(row.sampleSize),
    populationSize: Number(row.populationSize),
    avgWeightG: Number(row.averageWeight),
    avgLengthCm: numberOrNull(row.averageLength),
    weightCvPct: Number(row.weightCV),
    conditionFactor: numberOrNull(row.conditionFactor),
    estimatedBiomassKg: Number(row.estimatedBiomass),
    biomassGainKg: numberOrNull(row.biomassGain),
    performance: row.performance ?? null,
    isVerified: row.isVerified,
  };
}

/** Growth read surface for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class GrowthAiQueryResponder {
  private readonly logger = new Logger(GrowthAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS)
  getAnalysis(@Payload() payload: unknown): Promise<AiQueryReply<GrowthAnalysisReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS,
      payload,
      isBatchPerformanceRequest,
      async (req) => {
        const result = await this.queryBus.execute<GetGrowthAnalysisQuery, GrowthAnalysisResult>(
          new GetGrowthAnalysisQuery(req.tenantId, req.batchId),
        );
        return projectAnalysis(result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS)
  listMeasurements(@Payload() payload: unknown): Promise<AiQueryReply<GrowthMeasurementsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS,
      payload,
      isGrowthMeasurementsRequest,
      async (req) => {
        const page = await this.queryBus.execute<
          GetGrowthMeasurementsQuery,
          PaginatedQueryResult<GrowthMeasurement>
        >(
          new GetGrowthMeasurementsQuery(
            req.tenantId,
            { batchId: req.batchId },
            1,
            req.limit,
            'measurementDate',
            'DESC',
          ),
        );
        return toBoundedList(page.data, req.limit, projectMeasurement, page.pagination.total);
      },
    );
  }
}
