// ============================================================================
// AI Insights Hooks — TanStack Query wrappers for MCP-powered intelligence
// ============================================================================

/**
 * WHY: Custom hooks encapsulate all AI insight data fetching with proper error
 * handling, loading states, and caching. Uses TanStack Query for:
 *   - staleTime: 5 min — matches the backend Redis cache TTL, so re-fetching
 *     within 5 minutes just hits the client cache (zero network cost).
 *   - retry: 1 — if MCP is down, fail fast. The user sees "unavailable" instead
 *     of waiting through 3 retry cycles with exponential backoff.
 *   - Graceful degradation: when the query returns null (MCP_ENABLED=false or
 *     MCP unreachable), the hooks return null data with isError=false. Components
 *     interpret null as "AI unavailable" and show a subtle fallback message.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import {
  FARM_DASHBOARD_INSIGHTS_QUERY,
  TANK_RISK_ASSESSMENT_QUERY,
  BATCH_GROWTH_PREDICTION_QUERY,
  FEEDING_ADVICE_QUERY,
} from '@/graphql/ai-insights.queries';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type {
  FarmDashboardInsights,
  TankRiskAssessment,
  BatchGrowthPrediction,
  FeedingAdvice,
} from '@/types/ai-insights.types';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/**
 * WHY: 5-minute staleTime matches the backend Redis cache TTL for AI predictions.
 * AI predictions don't need real-time updates — they are computed from historical
 * data and change slowly. This constant is shared across all AI hooks to ensure
 * consistent caching behavior.
 */
const AI_STALE_TIME = 5 * 60 * 1000; // 5 minutes
const AI_GC_TIME = 30 * 60 * 1000; // 30 minutes in-memory retention
const AI_RETRY_COUNT = 1; // WHY: Fast fail when MCP is down — no point retrying 3 times

/**
 * WHY: Dashboard insights hook powers the AiInsightsCard on the home page.
 * Returns the aggregated farm-wide AI summary in a single query to avoid
 * N+1 requests when rendering the dashboard.
 */
export function useAiDashboardInsights(): UseQueryResult<FarmDashboardInsights | null, Error> {
  const { isAuthenticated, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'ai', 'dashboard-insights', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{
        farmDashboardInsights: FarmDashboardInsights | null;
      }>(FARM_DASHBOARD_INSIGHTS_QUERY);

      // WHY: Backend returns null when MCP_ENABLED=false or MCP is unreachable.
      // We treat null as a valid response — the component shows "unavailable".
      return result.farmDashboardInsights;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: AI_STALE_TIME,
    gcTime: AI_GC_TIME,
    retry: AI_RETRY_COUNT,
    // WHY: Don't refetch on window focus for AI predictions — they change slowly
    // and unnecessary refetches would hammer the MCP server.
    refetchOnWindowFocus: false,
  });
}

/**
 * WHY: Per-tank risk assessment hook for the tank detail page. Shows risk score,
 * contributing factors, and recommendations for a specific tank.
 */
export function useTankRiskAssessment(
  tankId: string | undefined,
): UseQueryResult<TankRiskAssessment | null, Error> {
  const { isAuthenticated, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'ai', 'tank-risk', tankId, tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{
        tankRiskAssessment: TankRiskAssessment | null;
      }>(TANK_RISK_ASSESSMENT_QUERY, { tankId });

      return result.tankRiskAssessment;
    },
    // WHY: Only fetch when tankId is available — prevents queries with undefined variables
    enabled: isAuthenticated && !!tenantId && !!tankId,
    staleTime: AI_STALE_TIME,
    gcTime: AI_GC_TIME,
    retry: AI_RETRY_COUNT,
    refetchOnWindowFocus: false,
  });
}

/**
 * WHY: Per-batch growth prediction hook for the tank detail page. Only fetched
 * when a batch is active (batchId is provided), since growth predictions require
 * historical batch data to compute.
 */
export function useBatchGrowthPrediction(
  batchId: string | null | undefined,
): UseQueryResult<BatchGrowthPrediction | null, Error> {
  const { isAuthenticated, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'ai', 'growth-prediction', batchId, tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{
        batchGrowthPrediction: BatchGrowthPrediction | null;
      }>(BATCH_GROWTH_PREDICTION_QUERY, { batchId });

      return result.batchGrowthPrediction;
    },
    // WHY: Only fetch when batchId is present — empty tanks have no growth to predict
    enabled: isAuthenticated && !!tenantId && !!batchId,
    staleTime: AI_STALE_TIME,
    gcTime: AI_GC_TIME,
    retry: AI_RETRY_COUNT,
    refetchOnWindowFocus: false,
  });
}

/**
 * WHY: Per-tank feeding advice hook for the tank detail page. Provides precision
 * feeding recommendations — the #1 operational cost lever in aquaculture.
 */
export function useFeedingAdvice(
  tankId: string | undefined,
): UseQueryResult<FeedingAdvice | null, Error> {
  const { isAuthenticated, tenantId } = useAuth();

  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'ai', 'feeding-advice', tankId, tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{
        feedingAdvice: FeedingAdvice | null;
      }>(FEEDING_ADVICE_QUERY, { tankId });

      return result.feedingAdvice;
    },
    // WHY: Only fetch when tankId is available — prevents queries with undefined variables
    enabled: isAuthenticated && !!tenantId && !!tankId,
    staleTime: AI_STALE_TIME,
    gcTime: AI_GC_TIME,
    retry: AI_RETRY_COUNT,
    refetchOnWindowFocus: false,
  });
}
