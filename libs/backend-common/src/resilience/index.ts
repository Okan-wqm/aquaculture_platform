/**
 * @aquaculture/backend-common/resilience
 *
 * Cross-cutting resilience primitives — circuit breakers, retry policies,
 * bulkhead patterns. Currently exposes the canonical CircuitBreaker
 * library; future additions land here so callers have one obvious
 * import path for resilience concerns.
 */

export * from './circuit-breaker';
