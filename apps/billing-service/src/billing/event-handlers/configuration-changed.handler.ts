import { DynamicStripeClientProvider } from '@aquaculture/backend-common/billing';
import { CONFIGURATION_CATALOG_DIGEST } from '@aquaculture/configuration-contracts';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  CONFIG_RUNTIME_ACCESS_BY_CONSUMER,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  type ConfigurationChangedEvent,
} from '@platform/event-contracts';

const BILLING_RUNTIME_ACCESS = CONFIG_RUNTIME_ACCESS_BY_CONSUMER['billing-service'];
if (!BILLING_RUNTIME_ACCESS) {
  throw new Error('billing-service is absent from configuration consumer SSOT');
}
const STRIPE_CONFIGURATION_IDS = new Set([
  ...BILLING_RUNTIME_ACCESS.nonSecretKeyIds,
  ...BILLING_RUNTIME_ACCESS.secretKeyIds,
]);

/**
 * ConfigurationChangedHandler — invalidates the DynamicStripeClientProvider
 * snapshot the moment an operator saves a `platform/billing.*` config row, so a
 * key change takes effect on the NEXT billing call instead of after the 30s TTL.
 *
 * Signal-only: the event carries NO value or secret. This handler ONLY calls
 * `invalidate()`; the provider re-fetches the effective settings (including the
 * decrypted secret over the trusted GET_SECRET path) on the next resolve(). The
 * TTL is the correctness backstop — a lost signal self-heals within 30s — so
 * this handler is a latency optimisation, not a dependency.
 */
@Injectable()
export class ConfigurationChangedHandler
  implements IEventHandler<ConfigurationChangedEvent>, OnModuleInit
{
  private readonly logger = new Logger(ConfigurationChangedHandler.name);

  constructor(
    private readonly dynamicStripeClientProvider: DynamicStripeClientProvider,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS unavailable — ConfigurationChanged signal not subscribed; the ' +
          'DynamicStripeClientProvider TTL still picks up config changes within its window',
      );
      return;
    }
    // events.*.ConfigurationChanged — platform config lives on the SYSTEM tenant,
    // but the wildcard keeps the publisher↔subscriber subject contract 3-segment.
    await this.eventBus.subscribeWildcard('ConfigurationChanged', this);
    this.logger.log('Subscribed to ConfigurationChanged (cross-tenant wildcard)');
  }

  getEventType(): string {
    return 'ConfigurationChanged';
  }

  async handle(event: ConfigurationChangedEvent): Promise<void> {
    // Only platform billing.* config on the SYSTEM tenant is relevant to the
    // Stripe client. Everything else is ignored (no value is ever read here).
    if (
      event.tenantId !== CONFIG_RUNTIME_SYSTEM_TENANT_ID ||
      event.catalogDigest !== CONFIGURATION_CATALOG_DIGEST ||
      !STRIPE_CONFIGURATION_IDS.has(event.catalogId)
    ) {
      return;
    }

    this.logger.log(
      `ConfigurationChanged for ${event.catalogId} — invalidating Stripe client snapshot`,
    );
    this.dynamicStripeClientProvider.invalidate();
    // Promise-returning by interface; no async work needed for a synchronous
    // in-memory invalidate. Return resolved so the interface contract holds.
    return Promise.resolve();
  }
}
