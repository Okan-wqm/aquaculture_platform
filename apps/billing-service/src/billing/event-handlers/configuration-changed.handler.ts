import { DynamicStripeClientProvider } from '@aquaculture/backend-common/billing';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import {
  CONFIG_RUNTIME_SERVICE,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  type ConfigurationChangedEvent,
} from '@platform/event-contracts';

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

  async handle(event: ConfigurationChangedEvent): Promise<HandlerOutcome> {
    // Only platform billing.* config on the SYSTEM tenant is relevant to the
    // Stripe client. Everything else is ignored (no value is ever read here).
    if (
      event.service !== CONFIG_RUNTIME_SERVICE ||
      event.tenantId !== CONFIG_RUNTIME_SYSTEM_TENANT_ID ||
      typeof event.key !== 'string' ||
      !event.key.startsWith('billing.')
    ) {
      return HandlerOutcome.ack();
    }

    this.logger.log(
      `ConfigurationChanged for ${event.service}/${event.key} — invalidating Stripe client snapshot`,
    );
    this.dynamicStripeClientProvider.invalidate();
    // Promise-returning by interface; no async work needed for a synchronous
    // in-memory invalidate. Return resolved so the interface contract holds.
    return Promise.resolve(HandlerOutcome.ack());
  }
}
