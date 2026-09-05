/**
 * Platform rate-limiting contracts (SEC-CRITICAL-002).
 *
 * WHY a shared module: auth-service shipped 0-byte rate-limit stubs while the
 * only real limiter lived inside gateway-api — a single gateway bypass (or a
 * direct subgraph reach on the internal network) removed ALL throttling from
 * login/MFA/reset (ADR-008 defense-in-depth violation). This module is the
 * single source of truth for request-rate limiting; gateway-api and every
 * subgraph consume the same store + guard semantics.
 */

/** A single counting window for one rate-limit key. */
export interface RateLimitEntry {
  /** Requests observed in the current window (including the current one). */
  count: number;
  /** Epoch milliseconds at which the window expires and the count resets. */
  resetTime: number;
}

export interface RateLimitIncrementResult {
  entry: RateLimitEntry;
  /** True when this increment created the window (count === 1). */
  isNew: boolean;
}

/**
 * Storage contract. Implementations MUST make incrementOrCreate atomic —
 * a read-modify-write here is a race that under-counts bursts exactly when
 * limiting matters most (concurrent brute-force).
 */
export interface RateLimitStore {
  incrementOrCreate(key: string, windowMs: number): Promise<RateLimitIncrementResult>;
  /**
   * WHY health surface: the guard's fail-closed decision needs to know the
   * difference between "store says over limit" and "store unreachable".
   */
  isHealthy(): boolean;
  /** Test/operational reset of all counters. */
  clear(): Promise<void>;
  /** Release timers/connections. */
  destroy(): void;
}

/** Injection token for the store backing the guard. */
export const RATE_LIMIT_STORE = 'PLATFORM_RATE_LIMIT_STORE';

/** Reflector metadata key carrying a route's rate-limit configuration. */
export const RATE_LIMIT_CONFIG_KEY = 'platformRateLimit';

/**
 * Identity facts the guard extracts from the execution context and hands to
 * a custom identifier extractor.
 */
export interface RateLimitIdentity {
  ip?: string;
  userId?: string;
  tenantId?: string;
  /** GraphQL args (or HTTP body) of the current operation, for field-based keys. */
  args?: Record<string, unknown>;
}

export interface RateLimitRouteConfig {
  /**
   * Stable bucket name. Part of the storage key — renaming it resets the
   * window, so treat it as an API.
   */
  name: string;
  /** Maximum requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Optional additional key dimension derived from the request — e.g. the
   * login email, so one attacker cannot consume another user's budget and a
   * distributed attacker cannot rotate IPs around a per-account lockout.
   * Return undefined to skip the dimension for this request.
   */
  identifier?: (identity: RateLimitIdentity) => string | undefined;
}

/* ------------------------------------------------------------------------- *
 * Edge mode (config-driven) — D2 / CRITICAL-002.
 *
 * WHY a second model: the gateway is a GraphQL/HTTP edge PROXY. It has no
 * decorated handler routes to carry @RateLimit metadata, so it cannot use the
 * decorator model above. Instead it classifies each request (by exact-match
 * path + JWT identity + GraphQL operation type) into a NAMED TIER. This
 * config-driven model lives in the SAME lib, behind an OPTIONAL injected
 * config, so decorator-only consumers (auth-service, every subgraph) are
 * structurally unaffected — they never wire an edge config, so the guard's
 * edge branch is never reached.
 * ------------------------------------------------------------------------- */

/** One named, config-driven limit tier. `name` becomes the storage-key prefix. */
export interface RateLimitTier {
  /** Stable tier name — part of the storage key, so treat it as an API. */
  name: string;
  /** Maximum requests per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Normalized path → tier mapping. Literal paths are matched exactly. Optional
 * path templates match one non-empty segment per `:parameter`, never a loose
 * prefix/substr/suffix, so dynamic resource routes can be protected without
 * reopening the SECREV-LOW-001 classifier bypass.
 */
export interface RateLimitEndpointBucket {
  /** Tier name this path family resolves to (must exist in `tiers`). */
  tier: string;
  /** Exact request paths owned by this tier. */
  paths: readonly string[];
  /** Segment-exact templates, e.g. `/api/marine/sites/:siteId/render`. */
  pathTemplates?: readonly string[];
  /**
   * GraphQL Mutation field names owned by this tier (e.g. `login`,
   * `verifyMfaLogin`). Authentication on this platform is a GraphQL
   * mutation, not a REST path: a login tier keyed only on `/auth/login`
   * never fires (SEC-HIGH-061). Matched exactly against the resolver field
   * the guard reads from GraphQLResolveInfo, so a query or another mutation
   * with a similar name does not share the bucket.
   */
  graphqlMutations?: readonly string[];
}

/**
 * Config-driven edge limiting policy, built once (from ConfigService) at the
 * gateway's RateLimitModule.forRoot. Absent for decorator-only consumers.
 */
export interface RateLimitEdgeConfig {
  /**
   * Named tiers. `default`/`anonymous`/`tenant` are the identity fallbacks the
   * guard always resolves; additional named tiers (e.g. `login`, `upload`,
   * `mutations`) are referenced by `endpointBuckets` / `mutationTier`.
   */
  tiers: {
    default: RateLimitTier;
    anonymous: RateLimitTier;
    tenant: RateLimitTier;
  } & Record<string, RateLimitTier>;
  /** Exact or segment-template path → tier mapping (overrides identity tier). */
  endpointBuckets: readonly RateLimitEndpointBucket[];
  /**
   * Tier applied ADDITIONALLY to GraphQL Mutation operations (not replacing the
   * identity/endpoint tier — both buckets are counted, mirroring the gateway's
   * previously-independent MutationRateLimitGuard). Omit to disable.
   */
  mutationTier?: string;
}

/**
 * Facts the edge resolver reads from a request. Populated by the guard from
 * either the HTTP request or the GraphQL context, so the pure edge resolvers
 * stay transport-agnostic and unit-testable.
 */
export interface EdgeRequestFacts {
  /** HTTP request path (with optional query string); undefined for non-HTTP. */
  url?: string;
  /** Lowercased header bag, for X-Forwarded-For / X-Real-IP fallback. */
  headers: Record<string, string | string[] | undefined>;
  /** Express trust-proxy-resolved IP (preferred over header parsing). */
  ip?: string;
  /** Raw socket/connection remote address (last-resort IP fallback). */
  remoteAddress?: string;
  /** JWT-verified user id (request.user.sub). */
  userId?: string;
  /** JWT-verified tenant id (request.user.tenantId) — NEVER a header value. */
  tenantId?: string;
  /** GraphQL operation parent type name ('Mutation' | 'Query' | …) when GraphQL. */
  graphqlParentType?: string;
  /** GraphQL resolver field name (`login`, `createBatch`, …) when GraphQL. */
  graphqlFieldName?: string;
}

/** Injection token for the optional edge policy (gateway-only). */
export const RATE_LIMIT_EDGE_CONFIG = 'PLATFORM_RATE_LIMIT_EDGE_CONFIG';

/** Shared constant bucket for requests whose client IP cannot be validated. */
export const INVALID_IP_BUCKET = 'invalid-ip';
