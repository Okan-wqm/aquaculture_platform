/**
 * @aquaculture/backend-common/resilience/circuit-breaker
 *
 * Canonical circuit-breaker library — single source for inter-service
 * resilience patterns across the platform.
 *
 * Usage:
 *
 * ```ts
 * import { CircuitBreakerService, DEFAULT_BREAKER_OPTIONS }
 *   from '@aquaculture/backend-common/resilience/circuit-breaker';
 *
 * await this.breaker.execute({
 *   serviceName: 'stripe-api',
 *   tenantId: tenant.id,
 *   fn: () => stripe.subscriptions.create({ … }),
 *   options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
 * });
 * ```
 */

export { CircuitBreakerService } from './circuit-breaker.service';
export { CircuitBreakerModule } from './circuit-breaker.module';
export {
  DEFAULT_BREAKER_OPTIONS,
  CircuitOpenError,
} from './circuit-breaker.types';
export type {
  CircuitBreakerOptions,
  FailureMode,
  CircuitState,
  CircuitStats,
} from './circuit-breaker.types';
