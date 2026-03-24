// ============================================================================
// AI Insights GraphQL Queries — MCP-powered farm intelligence
// ============================================================================

/**
 * WHY: Centralized AI insights queries — all MCP-powered intelligence is accessed
 * through the standard GraphQL layer. The mobile app never communicates with MCP
 * directly — farm-service mediates all calls and caches results in Redis (5 min TTL).
 * Keeping queries in a dedicated file avoids polluting operations.ts and enables
 * tree-shaking when AI features are not used.
 *
 * NOTE: All queries return nullable types on the backend. When MCP_ENABLED=false,
 * the resolver returns null and the frontend gracefully degrades to "unavailable".
 */

/**
 * WHY: Single aggregated query for the home dashboard card — fetches overall risk,
 * per-tank risks, anomalies, and feeding advice in one round-trip. This eliminates
 * N+1 queries on the most-visited screen.
 */
export const FARM_DASHBOARD_INSIGHTS_QUERY = `
  query FarmDashboardInsights {
    farmDashboardInsights {
      overallRiskScore
      tankRisks {
        tankId
        riskScore
        riskLevel
        factors
        recommendations
      }
      anomalies {
        type
        severity
        description
        affectedEntity
        suggestedActions
      }
      feedingAdvice {
        tankId
        recommendedAmount
        feedType
        feedingFrequency
        rationale
      }
    }
  }
`;

/**
 * WHY: Per-tank risk assessment query for the tank detail page. Fetched independently
 * from the dashboard so that navigating to a tank detail always gets fresh data for
 * that specific tank.
 */
export const TANK_RISK_ASSESSMENT_QUERY = `
  query TankRiskAssessment($tankId: ID!) {
    tankRiskAssessment(tankId: $tankId) {
      tankId
      riskScore
      riskLevel
      factors
      recommendations
    }
  }
`;

/**
 * WHY: Per-batch growth prediction query — shown on tank detail when a batch is active.
 * Separate from risk assessment because growth prediction requires a batchId, not tankId.
 */
export const BATCH_GROWTH_PREDICTION_QUERY = `
  query BatchGrowthPrediction($batchId: ID!) {
    batchGrowthPrediction(batchId: $batchId) {
      batchId
      currentAvgWeight
      predictedAvgWeight30d
      predictedSGR
      predictedFCR
      estimatedBiomass30d
    }
  }
`;

/**
 * WHY: Per-tank feeding advice query — displayed on tank detail to provide precision
 * feeding recommendations. Fetched per-tank so operators see advice for the tank
 * they are currently inspecting.
 */
export const FEEDING_ADVICE_QUERY = `
  query FeedingAdvice($tankId: ID!) {
    feedingAdvice(tankId: $tankId) {
      tankId
      recommendedAmount
      feedType
      feedingFrequency
      rationale
    }
  }
`;
