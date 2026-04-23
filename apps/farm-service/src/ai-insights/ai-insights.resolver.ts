/**
 * WHY: AiInsightsResolver is the GraphQL entry point for all AI-powered farm
 * intelligence queries. By using a dedicated resolver (rather than extending
 * existing resolvers), we:
 *  - Keep AI concerns isolated from CRUD operations (SRP)
 *  - Allow independent deployment and feature-flagging of AI capabilities
 *  - Provide a clear API surface for the mobile app team
 *
 * SECURITY: All queries are protected by the global TenantGuard (registered
 * in AppModule as APP_GUARD). The @CurrentTenant() decorator extracts the
 * tenant ID from the authenticated request context, ensuring tenant isolation
 * at the resolver level.
 *
 * NULLABILITY: All queries return nullable types because AI insights depend
 * on the MCP server being available. Mobile clients must handle null gracefully
 * (e.g. show a "No AI data available" placeholder).
 */
import { Resolver, Query, Args, ID } from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { CurrentTenant, Role, Roles } from '@aquaculture/backend-common';
import { AiInsightsService } from './services/ai-insights.service';
import {
  TankRiskAssessment,
  BatchGrowthPrediction,
  FarmAnomaly,
  FeedingAdvice,
  FarmDashboardInsights,
} from './types/ai-insights.types';

@Resolver()
export class AiInsightsResolver {
  private readonly logger = new Logger(AiInsightsResolver.name);

  constructor(private readonly aiInsightsService: AiInsightsService) {}

  /**
   * WHY: Per-tank risk assessment is the most requested AI insight on the
   * tank detail screen. Nullable return allows the mobile app to degrade
   * gracefully when the MCP server is unavailable.
   */
  @Query(() => TankRiskAssessment, {
    nullable: true,
    description: 'AI-powered risk assessment for a specific tank (0-100 score with factors)',
  })
  async tankRiskAssessment(
    @Args('tankId', { type: () => ID }) tankId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<TankRiskAssessment | null> {
    this.logger.debug(`tankRiskAssessment called for tank=${tankId}, tenant=${tenantId}`);
    return this.aiInsightsService.getTankRiskAssessment(tankId, tenantId);
  }

  /**
   * WHY: Growth prediction enables proactive harvest planning. The 30-day
   * window matches the typical production cycle checkpoint interval.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => BatchGrowthPrediction, {
    nullable: true,
    description: 'AI growth prediction for a batch over the next 30 days',
  })
  async batchGrowthPrediction(
    @Args('batchId', { type: () => ID }) batchId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<BatchGrowthPrediction | null> {
    this.logger.debug(`batchGrowthPrediction called for batch=${batchId}, tenant=${tenantId}`);
    return this.aiInsightsService.getBatchGrowthPrediction(batchId, tenantId);
  }

  /**
   * WHY: Farm-wide anomaly list powers the notification center and the
   * anomaly summary card on the dashboard. Returns an array (possibly empty)
   * rather than null — the mobile app always renders a list, even if empty.
   */
  @Query(() => [FarmAnomaly], {
    description: 'Active anomalies detected across the entire farm',
  })
  async farmAnomalies(
    @CurrentTenant() tenantId: string,
  ): Promise<FarmAnomaly[]> {
    this.logger.debug(`farmAnomalies called for tenant=${tenantId}`);
    return this.aiInsightsService.getFarmAnomalies(tenantId);
  }

  /**
   * WHY: Per-tank feeding advice reduces overfeeding, which is the primary
   * driver of water quality degradation. Nullable because the MCP
   * predict_feeding_impact tool may be unavailable.
   */
  @Query(() => FeedingAdvice, {
    nullable: true,
    description: 'AI-driven feeding recommendation for a specific tank',
  })
  async feedingAdvice(
    @Args('tankId', { type: () => ID }) tankId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedingAdvice | null> {
    this.logger.debug(`feedingAdvice called for tank=${tankId}, tenant=${tenantId}`);
    return this.aiInsightsService.getFeedingAdvice(tankId, tenantId);
  }

  /**
   * WHY: Dashboard insights is the composite endpoint that the mobile home
   * screen calls on launch. It aggregates risk + anomalies + feeding into
   * a single response, minimizing round trips over potentially slow mobile
   * connections.
   */
  @Query(() => FarmDashboardInsights, {
    description: 'Aggregated AI insights for the farm dashboard (risk + anomalies + feeding)',
  })
  async farmDashboardInsights(
    @CurrentTenant() tenantId: string,
  ): Promise<FarmDashboardInsights> {
    this.logger.debug(`farmDashboardInsights called for tenant=${tenantId}`);
    return this.aiInsightsService.getDashboardInsights(tenantId);
  }
}
