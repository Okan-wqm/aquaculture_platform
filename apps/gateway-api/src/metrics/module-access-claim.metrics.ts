import { isModuleAccess } from '@aquaculture/shared-contracts';
import * as client from 'prom-client';

/**
 * The share of verified access tokens that carry `moduleAccess` (plan PKG-04 accept, the R2
 * entry gate "mint metric at 100%"; RBAC-HIGH-028).
 *
 * WHY at the gateway: tokens minted by an auth replica of the previous release, or before
 * release R1, lack the claim and mean no grants. Only the gateway sees every token in use,
 * whichever replica minted it, so it counts each verified access token by its claim. One
 * access-token TTL after the last old auth replica is gone, `present` is 100%.
 *
 * Its own registry, contributed to /metrics by GatewayMetricsModule: the JWT middleware is built
 * outside Nest's DI in specs, and the count must not depend on how it was constructed. No tenant
 * or user label (the scrape surface is unauthenticated).
 */
export const MODULE_ACCESS_CLAIM_REGISTRY = new client.Registry();

export const MODULE_ACCESS_CLAIM_METRIC = 'gateway_access_token_module_access_total';

export type ModuleAccessClaimState = 'present' | 'absent' | 'malformed';

const tokensByClaim = new client.Counter({
  name: MODULE_ACCESS_CLAIM_METRIC,
  help:
    'Verified access tokens by their moduleAccess claim: present, absent (minted before release ' +
    'R1 or by an older auth replica) or malformed',
  labelNames: ['claim'] as const,
  registers: [MODULE_ACCESS_CLAIM_REGISTRY],
});

export function moduleAccessClaimState(claim: unknown): ModuleAccessClaimState {
  if (claim === undefined) return 'absent';
  return isModuleAccess(claim) ? 'present' : 'malformed';
}

/** Counts one verified access token by its `moduleAccess` claim. */
export function recordModuleAccessClaim(claim: unknown): void {
  tokensByClaim.inc({ claim: moduleAccessClaimState(claim) });
}
