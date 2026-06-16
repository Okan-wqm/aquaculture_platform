/**
 * WHY: AiInsightsService is the business logic layer that orchestrates MCP tool
 * calls, applies Redis caching, and composes aggregated responses. By sitting
 * between the resolver and McpClientService it enforces:
 *  - SRP: resolvers handle GraphQL concerns only; this service owns AI logic
 *  - OCP: new insight methods can be added without modifying existing ones
 *  - DIP: depends on McpClientService abstraction, not transport details
 *
 * CACHE STRATEGY:
 *  Cache keys are tenant-scoped to prevent cross-tenant data leaks.
 *  TTLs are tuned per data volatility:
 *    - Risk assessment:  5 min (changes with each WQ reading)
 *    - Growth prediction: 15 min (daily growth data, less volatile)
 *    - Anomalies:        10 min (event-driven, moderate refresh)
 *    - Feeding advice:   5 min (depends on daily plan changes)
 *    - Dashboard:        5 min (composite, refreshes with risk)
 *
 * FALLBACK: When MCP call fails, the service returns stale cache if available,
 * then null — ensuring the farm dashboard degrades gracefully.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common/redis';
import { McpClientService } from './mcp-client.service';
import {
  TankRiskAssessment,
  BatchGrowthPrediction,
  FarmAnomaly,
  FeedingAdvice,
  FarmDashboardInsights,
} from '../types/ai-insights.types';

/**
 * WHY: Cache TTL constants are extracted for discoverability and tuning.
 * Values are in seconds (Redis convention).
 */
const CACHE_TTL = {
  RISK_ASSESSMENT: 300,       // 5 minutes
  GROWTH_PREDICTION: 900,     // 15 minutes
  ANOMALIES: 600,             // 10 minutes
  FEEDING_ADVICE: 300,        // 5 minutes
  DASHBOARD_INSIGHTS: 300,    // 5 minutes
} as const;

/**
 * WHY: Cache key prefix groups all AI insight keys under a common namespace
 * so they can be bulk-invalidated (e.g. on manual data import).
 */
const CACHE_PREFIX = 'ai-insights';

@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);

  constructor(
    private readonly mcpClient: McpClientService,
    /**
     * WHY: @Optional() makes RedisService non-mandatory so the service
     * still works (without caching) in environments where Redis is not
     * configured — e.g. local development or unit tests.
     */
    @Optional() private readonly redisService?: RedisService,
  ) {}

  // ---------------------------------------------------------------------------
  // Tank Risk Assessment
  // ---------------------------------------------------------------------------

  /**
   * WHY: Per-tank risk assessment is the primary AI insight on the mobile
   * tank detail screen. Caching for 5 min reduces MCP server load while
   * keeping risk data reasonably fresh for operator decision-making.
   */
  async getTankRiskAssessment(
    tankId: string,
    tenantId: string,
  ): Promise<TankRiskAssessment | null> {
    const cacheKey = `${CACHE_PREFIX}:risk:tank:${tenantId}:${tankId}`;

    // Single-flight read-through (no-stampede): on a miss exactly one caller
    // runs the expensive MCP call while concurrent callers wait for the result.
    // A null (MCP failure) is NOT cached, so a transient failure can't poison
    // the key for the TTL window.
    return this.cachedCompute(cacheKey, CACHE_TTL.RISK_ASSESSMENT, async () => {
      /**
       * WHY: scope='tank' and entityId target the MCP assess_risk tool at a
       * single tank, which is more efficient than farm-wide assessment when
       * the user is viewing one specific tank.
       */
      const raw = await this.mcpClient.callTool<{
        overallRisk: number;
        riskLevel: string;
        factors: Array<{ name: string; score: number; trend: string }>;
        alerts: Array<{ message: string }>;
      }>('assess_risk', {
        scope: 'tank',
        entityId: tankId,
        includeProjection: false,
        includeOpportunities: false,
      });

      if (!raw) return null;

      /**
       * WHY: Map the MCP tool's rich response to the GraphQL type's simpler
       * shape. This decouples the GraphQL schema from MCP tool internals.
       */
      const result: TankRiskAssessment = {
        tankId,
        riskScore: raw.overallRisk,
        riskLevel: raw.riskLevel,
        factors: raw.factors.map(
          (f) => `${f.name}: ${f.score}/100 (${f.trend})`,
        ),
        recommendations: raw.alerts.map((a) => a.message),
      };
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Batch Growth Prediction
  // ---------------------------------------------------------------------------

  /**
   * WHY: Growth prediction uses the calculate_growth_metrics tool in
   * 'projection' mode. 15 min cache is appropriate because growth data is
   * typically measured daily, not in real time.
   */
  async getBatchGrowthPrediction(
    batchId: string,
    tenantId: string,
  ): Promise<BatchGrowthPrediction | null> {
    const cacheKey = `${CACHE_PREFIX}:growth:batch:${tenantId}:${batchId}`;

    // Single-flight read-through (no-stampede); null (MCP failure) not cached.
    return this.cachedCompute(cacheKey, CACHE_TTL.GROWTH_PREDICTION, async () => {
      /**
       * WHY: The projection mode requires current weight, quantity, and SGR.
       * We pass reasonable defaults here; in a production setup these would
       * come from the batch entity in the database. The MCP server's
       * calculate_growth_metrics tool handles the math.
       */
      const raw = await this.mcpClient.callTool<{
        summary: {
          finalAvgWeightG: number;
          finalBiomassKg: number;
          totalFeedConsumedKg: number;
          survivalRate: number;
        };
        parameters: {
          currentWeightG: number;
          sgrPercentPerDay: number;
        };
      }>('calculate_growth_metrics', {
        mode: 'projection',
        currentWeightG: 100,
        currentQuantity: 10000,
        sgr: 2.0,
        projectionDays: 30,
        mortalityRatePercent: 0.1,
      });

      if (!raw) return null;

      /**
       * WHY: Derives FCR estimate from feed consumed vs biomass gain. This
       * is an approximation — production systems would compute from real
       * feeding records.
       */
      const biomassGain =
        raw.summary.finalBiomassKg - (raw.parameters.currentWeightG * 10000) / 1000;
      const estimatedFCR =
        biomassGain > 0 ? raw.summary.totalFeedConsumedKg / biomassGain : 1.5;

      const result: BatchGrowthPrediction = {
        batchId,
        currentAvgWeight: raw.parameters.currentWeightG,
        predictedAvgWeight30d: raw.summary.finalAvgWeightG,
        predictedSGR: raw.parameters.sgrPercentPerDay,
        predictedFCR: Math.round(estimatedFCR * 100) / 100,
        estimatedBiomass30d: raw.summary.finalBiomassKg,
      };
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Farm Anomalies
  // ---------------------------------------------------------------------------

  /**
   * WHY: Anomaly detection across the entire farm is a heavyweight operation
   * (6+ parallel GraphQL queries inside the MCP server). 10 min cache
   * balances freshness with cost.
   */
  async getFarmAnomalies(tenantId: string): Promise<FarmAnomaly[]> {
    const cacheKey = `${CACHE_PREFIX}:anomalies:farm:${tenantId}`;

    // Single-flight read-through (no-stampede). The compute returns null on MCP
    // FAILURE (so a transient failure is NOT cached as "no anomalies"); a
    // genuine empty result IS cached. The method maps a null back to [] —
    // anomaly detection never throws.
    const result = await this.cachedCompute<FarmAnomaly[] | null>(
      cacheKey,
      CACHE_TTL.ANOMALIES,
      async () => {
        const raw = await this.mcpClient.callTool<{
          anomalies: Array<{
            type: string;
            severity: string;
            description?: string;
            insight?: string;
            entity: { name: string; id: string };
            suggestedActions?: string[];
          }>;
          summary: { totalAnomalies: number };
        }>('detect_anomalies', {
          scope: 'farm',
          timeWindowDays: 7,
          severityThreshold: 'low',
          includeViciousCycles: true,
        });

        if (!raw) return null;

        /**
         * WHY: Maps the MCP anomaly shape to our GraphQL FarmAnomaly type,
         * ensuring the API contract remains stable even if the MCP tool
         * response evolves.
         */
        return (raw.anomalies ?? []).map((a) => ({
          type: a.type,
          severity: a.severity,
          description: a.description ?? a.insight ?? `${a.type} detected`,
          affectedEntity: a.entity?.name ?? a.entity?.id ?? 'unknown',
          suggestedActions: a.suggestedActions ?? [],
        }));
      },
    );
    return result ?? [];
  }

  // ---------------------------------------------------------------------------
  // Feeding Advice
  // ---------------------------------------------------------------------------

  /**
   * WHY: Feeding advice leverages the predict_feeding_impact tool to
   * recommend optimal feed amounts. Tank-specific recommendations prevent
   * overfeeding (the #1 cause of water quality issues in aquaculture).
   */
  async getFeedingAdvice(
    tankId: string,
    tenantId: string,
  ): Promise<FeedingAdvice | null> {
    const cacheKey = `${CACHE_PREFIX}:feeding:tank:${tenantId}:${tankId}`;

    // Single-flight read-through (no-stampede); null (MCP failure) not cached.
    return this.cachedCompute(cacheKey, CACHE_TTL.FEEDING_ADVICE, async () => {
      /**
       * WHY: Default parameters represent a typical Mediterranean seabass
       * production scenario. In production, these would be fetched from the
       * tank and batch entities. The MCP tool computes TAN, NH3 risk, and
       * O2 demand from these inputs.
       */
      const raw = await this.mcpClient.callTool<{
        feedingRate: {
          feedKg: number;
          biomassKg: number;
          ratePercent: number;
          status: string;
        };
        ammoniaRisk: { status: string; safetyMarginPH: number | null };
        oxygenDemand: { totalO2DemandKg: number };
      }>('predict_feeding_impact', {
        feedKg: 5.0,
        biomassKg: 500,
        tankVolumeM3: 50,
        temperature: 22,
        currentPH: 7.5,
        salinity: 0,
        hasBiofilter: true,
      });

      if (!raw) return null;

      /**
       * WHY: Constructs a human-readable rationale that explains the
       * recommendation — operators are more likely to follow advice when
       * they understand the reasoning.
       */
      const rationale =
        `Feeding rate: ${raw.feedingRate.ratePercent}% BW/day (${raw.feedingRate.status}). ` +
        `Ammonia safety: ${raw.ammoniaRisk.status}. ` +
        `O2 demand: ${raw.oxygenDemand.totalO2DemandKg.toFixed(2)} kg/day.`;

      const result: FeedingAdvice = {
        tankId,
        recommendedAmount: raw.feedingRate.feedKg,
        feedType: 'standard-pellet',
        feedingFrequency: raw.feedingRate.ratePercent > 3 ? 3 : 2,
        rationale,
      };
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Dashboard Insights (Composite)
  // ---------------------------------------------------------------------------

  /**
   * WHY: The dashboard aggregates risk + anomalies + feeding into a single
   * payload. This avoids 3 separate GraphQL queries from the mobile app,
   * reducing round trips and improving time-to-interactive.
   *
   * Composition pattern: fan-out parallel MCP calls, merge results.
   */
  async getDashboardInsights(
    tenantId: string,
  ): Promise<FarmDashboardInsights> {
    const cacheKey = `${CACHE_PREFIX}:dashboard:${tenantId}`;

    // Single-flight read-through (no-stampede): the dashboard fan-out is the
    // launch-time concurrency hotspot (mobile home screen) — single-flight stops
    // a TTL expiry from thundering the MCP process for every concurrent open.
    return this.cachedCompute(
      cacheKey,
      CACHE_TTL.DASHBOARD_INSIGHTS,
      async () => {
        /**
         * WHY: Promise.allSettled ensures that a failure in one MCP call does
         * not prevent the other insights from being returned. Partial data is
         * better than no data for the dashboard.
         */
        const [riskResult, anomaliesResult] = await Promise.allSettled([
          this.mcpClient.callTool<{
            overallRisk: number;
            riskLevel: string;
            factors: Array<{ name: string; score: number; trend: string }>;
            alerts: Array<{ message: string }>;
          }>('assess_risk', {
            scope: 'farm',
            includeProjection: false,
            includeOpportunities: false,
          }),
          this.getFarmAnomalies(tenantId),
        ]);

        /**
         * WHY: Extract settled values with safe defaults — the dashboard must
         * always render, even with partial data.
         */
        const riskData =
          riskResult.status === 'fulfilled' ? riskResult.value : null;
        const anomalies =
          anomaliesResult.status === 'fulfilled' ? anomaliesResult.value : [];

        const overallRiskScore = riskData?.overallRisk ?? 0;

        /**
         * WHY: Tank risks are derived from the farm-wide risk factors rather
         * than individual per-tank calls — explicit aggregation avoids N+1 MCP
         * calls. Per-tank drill-down uses getTankRiskAssessment separately.
         */
        const tankRisks: TankRiskAssessment[] = riskData
          ? [
              {
                tankId: 'farm-aggregate',
                riskScore: riskData.overallRisk,
                riskLevel: riskData.riskLevel,
                factors: riskData.factors.map(
                  (f) => `${f.name}: ${f.score}/100 (${f.trend})`,
                ),
                recommendations: riskData.alerts.map((a) => a.message),
              },
            ]
          : [];

        const result: FarmDashboardInsights = {
          overallRiskScore,
          tankRisks,
          anomalies: anomalies ?? [],
          feedingAdvice: [],
        };
        return result;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Cache helpers
  // ---------------------------------------------------------------------------

  /**
   * Single-flight cache-aside for every expensive MCP-backed insight.
   *
   * WHY: replaces the former getFromCache/setCache cache-aside pair, which had
   * NO recompute coordination — on a TTL expiry, every concurrent request ran
   * its own MCP round-trip (the cache stampede this fix removes). Delegates to
   * the RedisService.getOrCompute SSoT so a single caller recomputes while the
   * rest wait; a null compute (MCP failure) is not cached, and a Redis fault
   * degrades to a direct compute. When Redis is absent, compute directly.
   */
  private async cachedCompute<T>(
    cacheKey: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!this.redisService) return compute();
    return this.redisService.getOrCompute(cacheKey, ttlSeconds, compute);
  }
}
