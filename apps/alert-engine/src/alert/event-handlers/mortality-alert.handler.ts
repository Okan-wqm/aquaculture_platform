import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { requiresDurableDelivery } from '@platform/event-contracts';
import type { MortalityAlertRaisedEvent } from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';
import { MortalityAlertService } from '../services/mortality-alert.service';

/**
 * MortalityAlertEventHandler
 *
 * Consumes the farm-raised `MortalityAlertRaised` event and converts it into a
 * real alert-engine incident (via MortalityAlertService). This is the consumer
 * that the dead farm-internal high-mortality alert was always missing: the alert
 * now lands as an escalatable AlertIncident instead of an EventEmitter2 emit with
 * no listener.
 *
 * IMPORTANT: NATS event handlers run OUTSIDE the HTTP request context — there is
 * no AsyncLocalStorage tenant context and no TenantSchemaMiddleware. The handler
 * establishes the per-tenant search_path context (mirroring
 * SensorReadingEventHandler) so MortalityAlertService's repository writes route
 * to the correct `tenant_<uuid>` schema.
 */
@Injectable()
export class MortalityAlertEventHandler
  implements IEventHandler<MortalityAlertRaisedEvent>, OnModuleInit
{
  private readonly logger = new Logger(MortalityAlertEventHandler.name);

  constructor(
    private readonly mortalityAlertService: MortalityAlertService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cross-tenant wildcard: `events.*.MortalityAlertRaised`, matching the
    // farm publisher's `events.{tenantId}.MortalityAlertRaised` for every tenant.
    await this.eventBus.subscribeWildcard('MortalityAlertRaised', this);
    this.logger.log(
      'Subscribed to MortalityAlertRaised events for incident creation (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'MortalityAlertRaised';
  }

  async handle(event: MortalityAlertRaisedEvent): Promise<void> {
    // SECURITY: tenantId must be a canonical UUID before it becomes a schema name.
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'MortalityAlertRaised event has missing/invalid tenantId — skipping ' +
          'to prevent cross-tenant incident creation.',
      );
      return;
    }

    this.logger.log(
      `Processing MortalityAlertRaised: batch=${event.batchId} ` +
        `type=${event.alertType} severity=${event.severity} ` +
        `tenant=${event.tenantId.substring(0, 8)}...`,
    );

    const schemaName = getTenantSchemaName(event.tenantId);
    const context: RequestContext = {
      tenantId: event.tenantId,
      schemaName,
      correlationId: event.correlationId,
    };

    try {
      await requestContextStorage.run(context, async () => {
        await this.mortalityAlertService.recordMortalityAlert(event);
      });
    } catch (error) {
      this.logger.error(
        `Error creating mortality incident: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // W7/D-B5: `MortalityAlertRaised` is `one_shot` — the mortality-recorded
      // listener raises it once, at write time, and no sweep re-raises it.
      // Swallowing here deletes a welfare event. Rethrow → NAK + backoff →
      // `alert.event_dlq` once retries are exhausted.
      if (requiresDurableDelivery(event.eventType)) {
        throw error;
      }
    }
  }
}
