import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { LowStockDetectedEvent } from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';
import { LowStockAlertService } from '../services/low-stock-alert.service';

/**
 * LowStockEventHandler (stock SSoT Phase 1)
 *
 * Consumes the farm-raised `LowStockDetected` event (emitted by the single
 * inventory-mutation sink for EVERY stock-reducing writer: manual movements,
 * feeding deductions, adjustments) and converts it into an escalatable
 * alert-engine incident via LowStockAlertService. Before this handler,
 * alert-engine had ZERO feed/stock event consumers — depletion signals
 * dead-ended in a websocket broadcast and an in-process emitter with no
 * listener (findings register FARM-HIGH-217).
 *
 * IMPORTANT: NATS event handlers run OUTSIDE the HTTP request context — the
 * handler establishes the per-tenant search_path context (mirroring
 * MortalityAlertEventHandler) so repository writes route to the correct
 * `tenant_<uuid>` schema.
 */
@Injectable()
export class LowStockEventHandler
  implements IEventHandler<LowStockDetectedEvent>, OnModuleInit
{
  private readonly logger = new Logger(LowStockEventHandler.name);

  constructor(
    private readonly lowStockAlertService: LowStockAlertService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cross-tenant wildcard: `events.*.LowStockDetected`, matching the farm
    // publisher's `events.{tenantId}.LowStockDetected` for every tenant.
    await this.eventBus.subscribeWildcard('LowStockDetected', this);
    this.logger.log(
      'Subscribed to LowStockDetected events for incident creation (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'LowStockDetected';
  }

  async handle(event: LowStockDetectedEvent): Promise<void> {
    // SECURITY: tenantId must be a canonical UUID before it becomes a schema name.
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'LowStockDetected event has missing/invalid tenantId — skipping ' +
          'to prevent cross-tenant incident creation.',
      );
      return;
    }

    this.logger.log(
      `Processing LowStockDetected: item=${event.itemType}/${event.itemId} ` +
        `severity=${event.severity} tenant=${event.tenantId.substring(0, 8)}...`,
    );

    const schemaName = getTenantSchemaName(event.tenantId);
    const context: RequestContext = {
      tenantId: event.tenantId,
      schemaName,
      correlationId: event.correlationId,
    };

    try {
      await requestContextStorage.run(context, async () => {
        await this.lowStockAlertService.recordLowStockAlert(event);
      });
    } catch (error) {
      // Swallow so NATS does not redeliver a poison message indefinitely.
      this.logger.error(
        `Error creating low-stock incident: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
