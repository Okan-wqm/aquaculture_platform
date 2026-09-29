import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus, type PaginatedQueryResult } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBatchPerformanceRequest,
  isGrowthMeasurementsRequest,
  toEventIso,
  type TenantBoundReply,
  type GrowthAnalysisReply,
  type GrowthMeasurementDto,
  type GrowthMeasurementsReply,
} from '@platform/event-contracts';
import { isoOrNull, numberOrNull, toBoundedList } from '../../common/nats/ai-query-responder';
import type { GrowthMeasurement } from '../entities/growth-measurement.entity';
import {
  GetGrowthAnalysisQuery,
  type GrowthAnalysisResult,
} from '../queries/get-growth-analysis.query';
import { GetGrowthMeasurementsQuery } from '../queries/get-growth-measurements.query';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

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
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS)
  getAnalysis(@Payload() payload: unknown): Promise<TenantBoundReply<GrowthAnalysisReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.GROWTH_ANALYSIS,
        isRequest: isBatchPerformanceRequest,
        handle: async (req, scope) => {
          const result = await this.queryBus.execute<GetGrowthAnalysisQuery, GrowthAnalysisResult>(
            new GetGrowthAnalysisQuery(scope, req.batchId),
          );
          return projectAnalysis(result);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS)
  listMeasurements(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<GrowthMeasurementsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.GROWTH_MEASUREMENTS,
        isRequest: isGrowthMeasurementsRequest,
        handle: async (req, scope) => {
          const page = await this.queryBus.execute<
            GetGrowthMeasurementsQuery,
            PaginatedQueryResult<GrowthMeasurement>
          >(
            new GetGrowthMeasurementsQuery(
              scope,
              { batchId: req.batchId },
              1,
              req.limit,
              'measurementDate',
              'DESC',
            ),
          );
          return toBoundedList(page.data, req.limit, projectMeasurement, page.pagination.total);
        },
      },
      payload,
    );
  }
}
