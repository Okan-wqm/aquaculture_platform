import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import { requiresDurableDelivery } from '@platform/event-contracts';
import type { WaterQualityCriticalEvent } from '@platform/event-contracts';
import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';
import { requestContextStorage, RequestContext } from '@aquaculture/backend-common/logging';
import { WaterQualityCriticalAlertService } from '../services/water-quality-critical-alert.service';

/**
 * WaterQualityCriticalEventHandler (FARM-MEDIUM-118)
 *
 * Consumes the farm-raised `WaterQualityCritical` event and converts it into a
 * real alert-engine incident (via WaterQualityCriticalAlertService). The farm
 * publishes this event reliably through its outbox on every measurement whose
 * parameters crossed their critical bounds; until this consumer existed it
 * only reached browsers via the gateway NATS bridge, so a critical excursion
 * never entered the alert lifecycle. The alert_engine NATS identity already
 * held the `events.*.WaterQualityCritical` subscribe permission
 * (infrastructure/nats/services.yaml) — the subscription simply had no
 * in-process handler.
 *
 * IMPORTANT: NATS event handlers run OUTSIDE the HTTP request context — there is
 * no AsyncLocalStorage tenant context and no TenantSchemaMiddleware. The handler
 * establishes the per-tenant search_path context (mirroring
 * MortalityAlertEventHandler) so the service's repository writes route to the
 * correct `tenant_<uuid>` schema.
 */
@Injectable()
export class WaterQualityCriticalEventHandler
  implements IEventHandler<WaterQualityCriticalEvent>, OnModuleInit
{
  private readonly logger = new Logger(WaterQualityCriticalEventHandler.name);

  constructor(
    // DI token is the service class; TS types are narrowed to exactly the
    // members this handler uses (Tier-1 "depend on exactly what you need")
    // so unit tests pass minimal doubles with no unsafe casts.
    @Inject(WaterQualityCriticalAlertService)
    private readonly waterQualityCriticalAlertService: Pick<
      WaterQualityCriticalAlertService,
      'recordCriticalWaterQuality'
    >,
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cross-tenant wildcard: `events.*.WaterQualityCritical`, matching the
    // farm publisher's `events.{tenantId}.WaterQualityCritical` for every tenant.
    await this.eventBus.subscribeWildcard('WaterQualityCritical', this);
    this.logger.log(
      'Subscribed to WaterQualityCritical events for incident creation (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'WaterQualityCritical';
  }

  async handle(event: WaterQualityCriticalEvent): Promise<HandlerOutcome> {
    // SECURITY: tenantId must be a canonical UUID before it becomes a schema name.
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'WaterQualityCritical event has missing/invalid tenantId — skipping ' +
          'to prevent cross-tenant incident creation.',
      );
      return HandlerOutcome.terminate('WaterQualityCritical: missing or invalid tenantId');
    }

    this.logger.log(
      `Processing WaterQualityCritical: measurement=${event.measurementId} ` +
        `tank=${event.tankId ?? event.equipmentId} params=${event.criticalParameterCount} ` +
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
        await this.waterQualityCriticalAlertService.recordCriticalWaterQuality(event);
      });
      return HandlerOutcome.ack();
    } catch (error) {
      // PLAT-HIGH-902: no swallowing. A validation/domain rejection can never
      // succeed and is dead-lettered; anything else is retried within the
      // consumer's delivery budget and dead-lettered when it is spent.
      this.logger.error(
        `Error creating water-quality incident: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // W7/D-B5: `WaterQualityCritical` is `one_shot` — emitted per critical
      // measurement at write time. A manual reading may be the only one for
      // hours, so "the next reading will re-raise it" is not a guarantee, and a
      // lost critical water-quality signal is a life-safety miss.
      return outcomeForError('water-quality-critical', error, {
        reproducible: !requiresDurableDelivery(event.eventType),
      });
    }
  }
}
