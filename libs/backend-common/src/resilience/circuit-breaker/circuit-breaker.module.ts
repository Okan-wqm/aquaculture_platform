import { Global, Module } from '@nestjs/common';

import { CircuitBreakerService } from './circuit-breaker.service';

/**
 * Global module that exposes the canonical CircuitBreakerService to
 * every consuming Nest module without per-module re-import.
 *
 * # Why @Global
 *
 * Circuit-breaker usage is cross-cutting — practically every service
 * has at least one external-call site (NATS publish, Redis op, HTTP
 * fetch, Stripe API). Requiring `imports: [CircuitBreakerModule]` in
 * every feature module would drown the import lists in boilerplate
 * and invite "I forgot to import it, my breaker is silently a no-op"
 * footguns. @Global is the right scope for this kind of platform-wide
 * primitive.
 *
 * # When to register
 *
 * Each service's AppModule imports `CircuitBreakerModule` exactly
 * once (typical pattern: top of the imports list alongside ConfigModule).
 * Feature modules then constructor-inject CircuitBreakerService
 * directly without further import.
 *
 * Closes: docs/reviews/circuit-breaker-auditor/2026-04-28-core-platform-review.md#CIRCUIT-CRITICAL-004 (canonical lib foundation)
 */
@Global()
@Module({
  providers: [CircuitBreakerService],
  exports: [CircuitBreakerService],
})
export class CircuitBreakerModule {}
