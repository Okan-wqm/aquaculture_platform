import { tenantScopedKey } from '@aquaculture/backend-common/redis';

/**
 * farm-service AI-insights Redis key builders — the ONLY place the insights
 * cache spells a key (K10 layer 5 / MT-HIGH-064; tests/invariants/
 * ai-tenant-boundary.spec.ts calls every builder with two tenants). Shapes
 * are unchanged: `ai-insights:<kind>:<tenantId>[:<id>]`.
 */

export function tankRiskCacheKey(tenantId: string, tankId: string): string {
  return tenantScopedKey('ai-insights:risk:tank', tenantId, tankId);
}

export function batchGrowthCacheKey(tenantId: string, batchId: string): string {
  return tenantScopedKey('ai-insights:growth:batch', tenantId, batchId);
}

export function farmAnomaliesCacheKey(tenantId: string): string {
  return tenantScopedKey('ai-insights:anomalies:farm', tenantId);
}

export function tankFeedingCacheKey(tenantId: string, tankId: string): string {
  return tenantScopedKey('ai-insights:feeding:tank', tenantId, tankId);
}

export function dashboardCacheKey(tenantId: string): string {
  return tenantScopedKey('ai-insights:dashboard', tenantId);
}
