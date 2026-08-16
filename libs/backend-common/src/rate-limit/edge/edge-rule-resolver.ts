import {
  EdgeRequestFacts,
  RateLimitEdgeConfig,
  RateLimitRouteConfig,
  RateLimitTier,
} from '../rate-limit.types';

import { classifyEndpoint, DEFAULT_TIER, matchesEndpoint } from './endpoint-classifier';

/*
 * Edge tier resolution — turns one request's facts into the rate-limit rules
 * that apply to it. Pure (no I/O, no NestJS), so the tiering policy is
 * unit-testable in isolation.
 */

function toRouteConfig(tier: RateLimitTier): RateLimitRouteConfig {
  // Edge rules carry no custom identifier — the guard's buildKey identity
  // precedence (user > tenant+ip > ip) supplies the key dimension.
  return {
    name: tier.name,
    limit: tier.limit,
    windowMs: tier.windowMs,
    requiresDistributedStore: tier.requiresDistributedStore,
  };
}

/**
 * Resolve the ordered rate-limit rules that apply to one edge request. ALL
 * returned rules are counted (reject on the first over-limit), so a request is
 * bounded by every rule that applies — never loosened by their interaction.
 *
 *  1. Primary identity/endpoint tier (always present):
 *       exact-match endpoint tier (login/upload) wins; else JWT-tenant →
 *       tenant tier; else no-user → anonymous tier; else default tier.
 *  2. Mutation tier (ADDITIVE, GraphQL Mutation only):
 *       mirrors the gateway's previously-independent MutationRateLimitGuard,
 *       which AND-ed with the identity tier. Counting it as a SECOND bucket
 *       preserves that semantics (e.g. an anonymous mutation stays bounded by
 *       the stricter of the anonymous tier and the mutation cap, not loosened
 *       to only the mutation cap).
 */
export function resolveEdgeRules(
  facts: EdgeRequestFacts,
  config: RateLimitEdgeConfig,
): RateLimitRouteConfig[] {
  const method = facts.method?.toUpperCase();
  if (
    method &&
    config.exemptions?.some(
      (exemption) =>
        exemption.methods.some((candidate) => candidate === method) &&
        matchesEndpoint(facts.url, exemption.paths),
    )
  ) {
    return [];
  }

  const rules: RateLimitRouteConfig[] = [toRouteConfig(resolvePrimaryTier(facts, config))];

  if (facts.graphqlParentType === 'Mutation' && config.mutationTier) {
    appendTier(rules, config, config.mutationTier);
  }

  if (method && isMutationMethod(method) && config.httpMutationTier) {
    appendTier(rules, config, config.httpMutationTier);
  }

  return rules;
}

function appendTier(
  rules: RateLimitRouteConfig[],
  config: RateLimitEdgeConfig,
  tierName: string,
): void {
  const tier = config.tiers[tierName];
  if (tier && !rules.some((rule) => rule.name === tier.name)) {
    rules.push(toRouteConfig(tier));
  }
}

function isMutationMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function resolvePrimaryTier(facts: EdgeRequestFacts, config: RateLimitEdgeConfig): RateLimitTier {
  // Endpoint classification wins (a login request is the login tier even for an
  // authenticated user — matching the gateway's getRateLimitConfig order).
  const endpointTier = classifyEndpoint(facts.url, config.endpointBuckets);
  if (endpointTier !== DEFAULT_TIER) {
    const tier = config.tiers[endpointTier];
    if (tier) {
      return tier;
    }
  }
  // JWT-verified tenant → elevated tenant tier. NEVER gate this on a header
  // tenantId (an unauthenticated attacker could claim the elevated bucket).
  if (facts.tenantId) {
    return config.tiers.tenant;
  }
  // Unauthenticated → strict anonymous tier.
  if (!facts.userId) {
    return config.tiers.anonymous;
  }
  // Authenticated without a tenant → default tier.
  return config.tiers.default;
}
