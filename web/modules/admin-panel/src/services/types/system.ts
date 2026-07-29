/**
 * System metrics & health types.
 *
 * GENERATED from the backend (`tools/codegen/admin-contracts/manifest.ts`).
 *
 * The hand-written versions had drifted in both directions. `SystemMetrics`
 * inlined every sub-shape and dropped `database.waitingClients`, so the one
 * number that says whether the pool is saturated could not be rendered.
 * `CircuitBreakerInfo` declared `state` as `'closed' | 'open' | 'half_open'`
 * against a backend that promised `string` — the panel was NARROWER than its
 * source, which is the direction nothing catches. That union is real, but it
 * lived in a private enum inside the email sender; it is exported and named now,
 * so the promise and the guess are the same declaration.
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  SystemMetrics,
  DatabaseMetrics,
  PlatformMetrics,
  ResourceMetrics,
  ServiceHealth,
  CircuitBreakerInfo,
  CircuitBreakerStatus,
} from './generated/admin-contracts';

export type {
  SystemMetrics,
  DatabaseMetrics,
  PlatformMetrics,
  ResourceMetrics,
  ServiceHealth,
  CircuitBreakerInfo,
  CircuitBreakerStatus,
};

/**
 * The breaker state vocabulary, DERIVED from the contract rather than restated.
 *
 * The generator inlines an enum-typed property as its value union, which is the
 * correct wire form. Naming the union here gives readers something to point a
 * `Record` at without introducing a second declaration of the members.
 */
export type CircuitBreakerState = CircuitBreakerInfo['state'];
