import { DynamicModule, Module, Provider, Type, ForwardReference } from '@nestjs/common';

import { CircuitBreakerModule } from '../resilience/circuit-breaker';

import { StripeApiService } from './stripe-api.service';
import { STRIPE_API_CLIENT, STRIPE_AUDIT_RECORDER } from './stripe-api.types';

/**
 * Billing-API module — provides the canonical StripeApiService.
 *
 * # Why dynamic forRoot()
 *
 * Production wiring binds a real Stripe client factory + the canonical
 * AuditLogService. Tests bind stub providers. forRoot() takes both as
 * Provider tuples so the test path can pass `useValue: stubClient`
 * without wrestling with provider tokens.
 *
 * # Required CircuitBreakerModule
 *
 * StripeApiService depends on CircuitBreakerService. forRoot() imports
 * CircuitBreakerModule so callers do NOT have to remember to import it
 * separately — the wiring is one-stop.
 *
 * # Phase 2 expectation (W1.1)
 *
 * Once `stripe@^17.x` is added to the workspace and the
 * StripeClientFactory is implemented, production wiring becomes:
 *
 *   StripeApiModule.forRoot({
 *     clientProvider: { provide: STRIPE_API_CLIENT, useFactory: stripeClientFactory },
 *     auditProvider:  { provide: STRIPE_AUDIT_RECORDER, useExisting: AuditLogService },
 *   })
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-CRITICAL-001 (foundation)
 */
@Module({})
export class StripeApiModule {
  static forRoot(opts: {
    clientProvider: Provider;
    auditProvider: Provider;
    /**
     * Extra modules the client/audit providers depend on (e.g. the Faz C
     * ConfigClientModule that provides the ConfigRuntimeClient the
     * DynamicStripeClientProvider injects). Merged after CircuitBreakerModule so
     * the clientProvider's `inject` tokens resolve inside StripeApiModule's scope.
     */
    imports?: Array<Type<unknown> | DynamicModule | ForwardReference>;
    /**
     * Extra providers registered in StripeApiModule's scope (e.g. the
     * DynamicStripeClientProvider the clientProvider factory injects).
     */
    providers?: Provider[];
    /**
     * Extra exports so an importing module (billing) can inject a provider
     * declared here (e.g. DynamicStripeClientProvider → the ConfigurationChanged handler).
     */
    exports?: Array<Provider | symbol | string | Type<unknown>>;
  }): DynamicModule {
    // Sanity: the two provider tuples MUST target the canonical tokens —
    // otherwise StripeApiService cannot resolve its dependencies.
    return {
      module: StripeApiModule,
      imports: [CircuitBreakerModule, ...(opts.imports ?? [])],
      providers: [
        ...(opts.providers ?? []),
        opts.clientProvider,
        opts.auditProvider,
        StripeApiService,
      ],
      exports: [StripeApiService, ...(opts.exports ?? [])],
    };
  }
}

export { STRIPE_API_CLIENT, STRIPE_AUDIT_RECORDER };
