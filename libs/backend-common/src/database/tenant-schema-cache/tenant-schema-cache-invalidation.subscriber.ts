import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import { InvalidEventTenantScopeError, requireTenantScope } from '@platform/event-contracts';
import type { TenantProvisionedEvent } from '@platform/event-contracts';

import { getTenantSchemaName } from '../tenant-schema.utils';

import { TenantSchemaCacheService } from './tenant-schema-cache.service';

/**
 * Clears the tenant schema-existence negative cache the instant a tenant
 * finishes provisioning.
 *
 * # Root cause it closes
 *
 * `TenantSchemaMiddleware` negatively caches "schema does not exist" for 30s
 * (DoS guard against bad tenant IDs). If any request for tenant X lands during
 * the provisioning window — before aqua-db-migrate creates `tenant_<uuid>` —
 * that negative entry would otherwise keep blocking the freshly-provisioned
 * tenant with `UnauthorizedException('Tenant not provisioned')` for up to 30s
 * AFTER its schema already exists. The provisioning saga already publishes
 * `TenantProvisioned` once the schema is committed and the tenant activated;
 * subscribing here makes a correct cache state the automatic, zero-effort
 * default (no negative-TTL tuning, no manual flush) — the make-it-automatic
 * tier of the architectural hierarchy.
 *
 * `EVENT_BUS` is `@Optional()` so dev/test harnesses without NATS still boot;
 * in that degraded mode the negative TTL is the only fallback, which is
 * acceptable for non-production.
 */
@Injectable()
export class TenantSchemaCacheInvalidationSubscriber
  implements IEventHandler<TenantProvisionedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantSchemaCacheInvalidationSubscriber.name);

  constructor(
    private readonly schemaCache: TenantSchemaCacheService,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS unavailable — tenant schema-cache invalidation disabled; ' +
          'falling back to negative-TTL expiry only (acceptable for dev/test).',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('TenantProvisioned', this);
    this.logger.log('Subscribed to TenantProvisioned for tenant schema-cache invalidation');
  }

  getEventType(): string {
    return 'TenantProvisioned';
  }

  // Non-async (returns a resolved Promise) because the work is synchronous —
  // backend-common lints @typescript-eslint/require-await as an error, and there
  // is nothing to await. The IEventHandler contract only requires a resolved
  // HandlerOutcome.
  handle(event: TenantProvisionedEvent): Promise<HandlerOutcome> {
    // SEC-HIGH-057 / PLAT-MEDIUM-905: tenancy is parsed through the contract,
    // not a hand-rolled UUID guard. TenantProvisioned is tenant-bound by
    // construction; a malformed or platform scope is terminated.
    let tenantId: string;
    try {
      tenantId = requireTenantScope(event).tenantId;
    } catch (error) {
      if (error instanceof InvalidEventTenantScopeError) {
        return Promise.resolve(HandlerOutcome.terminate(error.message, error));
      }
      throw error;
    }
    // schemaName is a tenant_<hash> derived value; do not log it (PII discipline).
    this.schemaCache.invalidate(getTenantSchemaName(tenantId));
    this.logger.log('Invalidated tenant schema-existence cache after TenantProvisioned');
    return Promise.resolve(HandlerOutcome.ack());
  }
}
