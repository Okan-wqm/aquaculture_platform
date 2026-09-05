import {
  EdgeRequestFacts,
  RateLimitEdgeConfig,
  RateLimitRouteConfig,
  RateLimitTier,
} from '../rate-limit.types';

import { classifyEndpoint, classifyGraphqlOperation, DEFAULT_TIER } from './endpoint-classifier';

/*
 * Edge tier resolution — turns one request's facts into the rate-limit rules
 * that apply to it. Pure (no I/O, no NestJS), so the tiering policy is
 * unit-testable in isolation.
 */

function toRouteConfig(tier: RateLimitTier): RateLimitRouteConfig {
  // Edge rules carry no custom identifier — the guard's buildKey identity
  // precedence (user > tenant+ip > ip) supplies the key dimension.
  return { name: tier.name, limit: tier.limit, windowMs: tier.windowMs };
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
  const rules: RateLimitRouteConfig[] = [toRouteConfig(resolvePrimaryTier(facts, config))];

  if (facts.graphqlParentType === 'Mutation' && config.mutationTier) {
    const mutationTier = config.tiers[config.mutationTier];
    if (mutationTier) {
      rules.push(toRouteConfig(mutationTier));
    }
  }

  return rules;
}

function resolvePrimaryTier(facts: EdgeRequestFacts, config: RateLimitEdgeConfig): RateLimitTier {
  // Endpoint classification wins (a login request is the login tier even for an
  // authenticated user — matching the gateway's getRateLimitConfig order). A
  // GraphQL operation is classified by its resolver field first: every
  // GraphQL request shares the one `/graphql` URL, so the path alone can
  // never single out `login` (SEC-HIGH-061).
  const operationTier = classifyGraphqlOperation(
    facts.graphqlParentType,
    facts.graphqlFieldName,
    config.endpointBuckets,
  );
  const endpointTier =
    operationTier !== DEFAULT_TIER
      ? operationTier
      : classifyEndpoint(facts.url, config.endpointBuckets);
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
