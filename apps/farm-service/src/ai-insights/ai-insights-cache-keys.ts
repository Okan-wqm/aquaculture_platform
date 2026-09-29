import { tenantScopedKey } from '@aquaculture/backend-common/redis';

/**
 * farm-service AI-insights Redis key builders — the ONLY place the insights
 * cache spells a key (K10 layer 5 / MT-HIGH-064; tests/invariants/
 * ai-tenant-boundary.spec.ts calls every builder with two tenants). Shape:
 * `ai-insights:v2:<kind>:<tenantId>[:<id>]`.
 *
 * WHY the `v2` family (V-T1b-3): entries written before the MCP bridge was
 * bound to its session tenant sit under the v1 keys of EVERY tenant but may
 * hold the session tenant's answers. A new key family makes every one of them
 * unreachable the moment this deploys, instead of being served for up to a
 * TTL; the v1 entries expire on their own.
 */
const FAMILY = 'ai-insights:v2';

export function tankRiskCacheKey(tenantId: string, tankId: string): string {
  return tenantScopedKey(`${FAMILY}:risk:tank`, tenantId, tankId);
}

export function batchGrowthCacheKey(tenantId: string, batchId: string): string {
  return tenantScopedKey(`${FAMILY}:growth:batch`, tenantId, batchId);
}

export function farmAnomaliesCacheKey(tenantId: string): string {
  return tenantScopedKey(`${FAMILY}:anomalies:farm`, tenantId);
}

export function tankFeedingCacheKey(tenantId: string, tankId: string): string {
  return tenantScopedKey(`${FAMILY}:feeding:tank`, tenantId, tankId);
}

export function dashboardCacheKey(tenantId: string): string {
  return tenantScopedKey(`${FAMILY}:dashboard`, tenantId);
}
