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
