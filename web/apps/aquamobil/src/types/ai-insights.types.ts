// ============================================================================
// AI Insights Type Definitions — Frontend mirrors of farm-service GraphQL types
// ============================================================================

/**
 * WHY: Frontend type mirrors of the backend TankRiskAssessment, BatchGrowthPrediction,
 * FarmAnomaly, FeedingAdvice, and FarmDashboardInsights GraphQL ObjectTypes.
 * Keeping a dedicated file prevents ai-insights types from polluting the main
 * types/index.ts and enables tree-shaking when AI features are disabled.
 */

/**
 * WHY: Per-tank risk assessment enables color-coded risk badges on tank cards
 * and detailed risk breakdowns on the tank detail page.
 */
export interface TankRiskAssessment {
  tankId: string;
  /** WHY: Numeric 0-100 score drives circular gauge rendering and threshold-based color coding */
  riskScore: number;
  /** WHY: Categorical level (LOW/MEDIUM/HIGH/CRITICAL) used for badge color mapping */
  riskLevel: string;
  /** WHY: Contributing factors give operators transparency into why a risk level was assigned */
  factors: string[];
  /** WHY: Actionable recommendations reduce mean-time-to-resolution for detected risks */
  recommendations: string[];
}

/**
 * WHY: 30-day growth prediction helps farm managers plan harvest timing
 * and feed procurement proactively — the two highest-cost decisions in aquaculture.
 */
export interface BatchGrowthPrediction {
  batchId: string;
  /** WHY: Current baseline weight anchors the prediction context for the user */
  currentAvgWeight: number;
  /** WHY: Predicted weight drives harvest planning decisions */
  predictedAvgWeight30d: number;
  /** WHY: SGR (Specific Growth Rate) indicates biological performance trend */
  predictedSGR: number;
  /** WHY: FCR (Feed Conversion Ratio) drives feed cost optimization decisions */
  predictedFCR: number;
  /** WHY: Projected biomass enables capacity planning and sales forecasting */
  estimatedBiomass30d: number;
}

/**
 * WHY: Anomaly detection surfaces unexpected events (mortality spikes, water quality
 * deviations) that would otherwise go unnoticed until manual inspection.
 */
export interface FarmAnomaly {
  /** WHY: Anomaly type (e.g. mortality_spike, wq_deviation) enables category-based filtering */
  type: string;
  /** WHY: Severity level (low/medium/high/critical) drives notification priority and badge color */
  severity: string;
  /** WHY: Human-readable description for operator situational awareness */
  description: string;
  /** WHY: Identifies which entity (tank/batch/site) is affected for drill-down navigation */
  affectedEntity: string;
  /** WHY: Suggested remediation actions provide immediate guidance to field operators */
  suggestedActions: string[];
}

/**
 * WHY: Precision feeding recommendations per tank reduce FCR, lower waste, and
 * improve water quality — the #1 operational cost lever in aquaculture.
 */
export interface FeedingAdvice {
  tankId: string;
  /** WHY: Recommended feed amount in kg enables direct operational action */
  recommendedAmount: number;
  /** WHY: Feed type recommendation considers species-specific nutritional needs */
  feedType: string;
  /** WHY: Feeding frequency affects digestion efficiency and water quality */
  feedingFrequency: number;
  /** WHY: Rationale builds operator trust in AI recommendations — humans need to understand "why" */
  rationale: string;
}

/**
 * WHY: Aggregated dashboard payload provides a single-query entry point for the
 * mobile farm dashboard, reducing N+1 API calls and improving perceived latency
 * for the most frequently accessed screen.
 */
export interface FarmDashboardInsights {
  /** WHY: Single numeric health indicator for the executive summary card */
  overallRiskScore: number;
  /** WHY: Per-tank risk breakdown enables targeted intervention from the dashboard */
  tankRisks: TankRiskAssessment[];
  /** WHY: Active anomalies drive the alert badge count and anomaly triage view */
  anomalies: FarmAnomaly[];
  /** WHY: Feeding advice powers the daily feeding plan optimization */
  feedingAdvice: FeedingAdvice[];
}
