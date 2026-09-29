import { tenantScopedKey } from '@aquaculture/backend-common/redis';

/**
 * ai-service Redis key builders — the ONLY place ai-service spells a Redis key
 * (K10 layer 5 / MT-HIGH-062; tests/invariants/ai-tenant-boundary.spec.ts).
 *
 * WHY here and not inline in the services: the invariant calls every builder
 * exported from this module with two tenants and proves the tenant is the
 * first variable segment; an inline key would escape that proof. The shapes
 * are unchanged from before K10 (`ai:tokens:{tenant}:{YYYY-MM}`,
 * `ai:ratelimit[:{ns}]:{tenant}:{YYYY-MM-DD-HH}`), so live counters survive
 * the deploy.
 */

/** Monthly token budget counter. */
export function aiTokenBudgetKey(tenantId: string, monthBucket: string): string {
  return tenantScopedKey('ai:tokens', tenantId, monthBucket);
}

/**
 * Hourly request counter. `namespace` is an allowlisted service namespace
 * (RateLimitService.RATE_NAMESPACES) or null for the user-chat counter.
 */
export function aiRateLimitKey(
  tenantId: string,
  hourBucket: string,
  namespace: string | null,
): string {
  return tenantScopedKey(
    namespace === null ? 'ai:ratelimit' : `ai:ratelimit:${namespace}`,
    tenantId,
    hourBucket,
  );
}
