/**
 * WHY: Strongly-typed GraphQL ObjectTypes for MCP tool responses ensure type
 * safety across the entire chain: MCP Server -> McpClient -> Service -> Resolver -> Mobile.
 * Without these, tool responses would be untyped Record<string, unknown> and
 * consumers would lose compile-time guarantees.
 */
import { ObjectType, Field, Float, Int, ID } from '@nestjs/graphql';

/**
 * WHY: Encapsulates AI-powered risk assessment for a single tank so that
 * the mobile dashboard can render per-tank risk cards with actionable
 * recommendations without additional API calls.
 */
@ObjectType({ description: 'AI-powered risk assessment for a specific tank' })
export class TankRiskAssessment {
  @Field(() => ID, { description: 'WHY: Identifies which tank this risk belongs to for UI routing' })
  tankId!: string;

  @Field(() => Float, { description: 'WHY: Numeric 0-100 score enables gauge/meter rendering' })
  riskScore!: number;

  @Field(() => String, { description: 'WHY: Categorical level (LOW/MEDIUM/HIGH/CRITICAL) for color-coding UI' })
  riskLevel!: string;

  @Field(() => [String], { description: 'WHY: Explains which factors contribute to risk — transparency for operators' })
  factors!: string[];

  @Field(() => [String], { description: 'WHY: Actionable next steps reduce mean-time-to-resolution' })
  recommendations!: string[];
}

/**
 * WHY: Provides 30-day forward-looking growth prediction per batch so that
 * farm managers can plan harvest timing and feed procurement proactively.
 */
@ObjectType({ description: 'Growth prediction for a batch over the next 30 days' })
export class BatchGrowthPrediction {
  @Field(() => ID, { description: 'WHY: Links prediction to the batch entity for drill-down navigation' })
  batchId!: string;

  @Field(() => Float, { description: 'WHY: Current baseline weight anchors the prediction context' })
  currentAvgWeight!: number;

  @Field(() => Float, { description: 'WHY: Predicted weight drives harvest planning decisions' })
  predictedAvgWeight30d!: number;

  @Field(() => Float, { description: 'WHY: SGR (Specific Growth Rate) indicates biological performance trend' })
  predictedSGR!: number;

  @Field(() => Float, { description: 'WHY: FCR (Feed Conversion Ratio) drives feed cost optimization' })
  predictedFCR!: number;

  @Field(() => Float, { description: 'WHY: Projected biomass enables capacity planning and sales forecasting' })
  estimatedBiomass30d!: number;
}

/**
 * WHY: Represents a detected anomaly in farm operations. Structured to allow
 * the mobile app to sort by severity and group by type for triage views.
 */
@ObjectType({ description: 'Detected anomaly in farm operations' })
export class FarmAnomaly {
  @Field(() => String, { description: 'WHY: Anomaly type (e.g. mortality_spike, wq_deviation) enables category filtering' })
  type!: string;

  @Field(() => String, { description: 'WHY: Severity level (low/medium/high/critical) drives notification priority' })
  severity!: string;

  @Field(() => String, { description: 'WHY: Human-readable description for operator situational awareness' })
  description!: string;

  @Field(() => String, { description: 'WHY: Identifies which entity (tank/batch/site) is affected for navigation' })
  affectedEntity!: string;

  @Field(() => [String], { description: 'WHY: Suggested actions provide immediate remediation guidance' })
  suggestedActions!: string[];
}

/**
 * WHY: Encapsulates AI-driven feeding recommendations per tank. Precision
 * feeding reduces FCR, lowers waste, and improves water quality — the #1
 * operational cost lever in aquaculture.
 */
@ObjectType({ description: 'AI-driven feeding recommendation for a tank' })
export class FeedingAdvice {
  @Field(() => ID, { description: 'WHY: Links advice to specific tank for targeted feed distribution' })
  tankId!: string;

  @Field(() => Float, { description: 'WHY: Recommended feed amount in kg enables direct operational action' })
  recommendedAmount!: number;

  @Field(() => String, { description: 'WHY: Feed type recommendation considers species-specific nutritional needs' })
  feedType!: string;

  @Field(() => Int, { description: 'WHY: Feeding frequency affects digestion efficiency and water quality' })
  feedingFrequency!: number;

  @Field(() => String, { description: 'WHY: Rationale builds operator trust in AI recommendations' })
  rationale!: string;
}

/**
 * WHY: Aggregated dashboard payload provides a single-query entry point for
 * the mobile farm dashboard, reducing N+1 API calls and improving perceived
 * latency for the most frequently accessed screen.
 */
@ObjectType({ description: 'Aggregated AI insights for the farm dashboard' })
export class FarmDashboardInsights {
  @Field(() => Float, { description: 'WHY: Single numeric health indicator for the executive summary card' })
  overallRiskScore!: number;

  @Field(() => [TankRiskAssessment], { description: 'WHY: Per-tank risk breakdown enables targeted intervention' })
  tankRisks!: TankRiskAssessment[];

  @Field(() => [FarmAnomaly], { description: 'WHY: Active anomalies drive the notification bell badge count' })
  anomalies!: FarmAnomaly[];

  @Field(() => [FeedingAdvice], { description: 'WHY: Feeding advice powers the daily feeding plan screen' })
  feedingAdvice!: FeedingAdvice[];
}
