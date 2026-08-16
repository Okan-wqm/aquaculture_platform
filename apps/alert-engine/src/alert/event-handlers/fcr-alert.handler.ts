import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { requiresDurableDelivery } from '@platform/event-contracts';
import type { FCRAlertEvent } from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';
import { FcrAlertService } from '../services/fcr-alert.service';

/**
 * FcrAlertEventHandler (feeding-protocol cycle, C-1)
 *
 * Consumes the farm-raised `FCRAlert` event (18:00 sweep — the contract's
 * FIRST durable emission) and converts it into an escalatable alert-engine
 * incident via FcrAlertService. Before this handler, FCR breaches dead-ended
 * in an in-process log chain inside farm-service — no incident anywhere.
 *
 * IMPORTANT: NATS event handlers run OUTSIDE the HTTP request context — the
 * handler establishes the per-tenant search_path context (mirroring
 * LowStockEventHandler) so repository writes route to the correct
 * `tenant_<uuid>` schema.
 */
@Injectable()
export class FcrAlertEventHandler implements IEventHandler<FCRAlertEvent>, OnModuleInit {
  private readonly logger = new Logger(FcrAlertEventHandler.name);

  constructor(
    private readonly fcrAlertService: FcrAlertService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cross-tenant wildcard: `events.*.FCRAlert`, matching the farm
    // publisher's `events.{tenantId}.FCRAlert` for every tenant.
    await this.eventBus.subscribeWildcard('FCRAlert', this);
    this.logger.log(
      'Subscribed to FCRAlert events for incident creation (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'FCRAlert';
  }

  async handle(event: FCRAlertEvent): Promise<void> {
    // SECURITY: tenantId must be a canonical UUID before it becomes a schema name.
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'FCRAlert event has missing/invalid tenantId — skipping ' +
          'to prevent cross-tenant incident creation.',
      );
      return;
    }

    this.logger.log(
      `Processing FCRAlert: batch=${event.batchId} level=${event.alertLevel} ` +
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
        await this.fcrAlertService.recordFcrAlert(event);
      });
    } catch (error) {
      this.logger.error(
        `Error creating FCR incident: ${(error as Error).message}`,
        (error as Error).stack,
      );
      if (requiresDurableDelivery(event.eventType)) {
        throw error;
      }
    }
  }
}
