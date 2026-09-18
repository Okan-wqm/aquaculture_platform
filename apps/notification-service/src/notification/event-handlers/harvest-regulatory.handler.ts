import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import type { HarvestRegulatoryRecordedEvent } from '@platform/event-contracts';
import { InAppNotificationService } from '../services/in-app.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * HarvestRegulatoryRecordedEventHandler
 *
 * Consumes the `HarvestRegulatoryRecorded` follow-up emitted by farm-service on
 * every harvest. Records an in-app traceability confirmation for the operator
 * who performed the harvest, so the food-safety/recall traceability event is
 * wire-visible AND surfaces to the operator. This is the previously-missing
 * consumer for the dead `regulatory.harvestRecorded` in-process emit.
 *
 * WHY in-app (not email/SMS): a per-harvest traceability record is an audit
 * confirmation, not an urgent alert — the IN_APP NotificationLog is the existing
 * primitive for operator-visible records (mirrors TaskEventHandler). The urgent
 * Mattilsynet "varsling" reports (welfare/escape/disease) are a SEPARATE family
 * handled by RegulatoryReportEventHandler via email.
 */
@Injectable()
export class HarvestRegulatoryRecordedEventHandler
  implements IEventHandler<HarvestRegulatoryRecordedEvent>, OnModuleInit
{
  private readonly logger = new Logger(HarvestRegulatoryRecordedEventHandler.name);

  constructor(
    // DI token is the InAppNotificationService class; TS type narrowed to the
    // single method used (Tier-1 "depend on exactly what you need") so unit
    // tests pass a minimal double with no unsafe casts.
    @Inject(InAppNotificationService)
    private readonly inAppService: Pick<InAppNotificationService, 'createNotification'>,
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cross-tenant wildcard: `events.*.HarvestRegulatoryRecorded`, matching the
    // farm publisher's `events.{tenantId}.HarvestRegulatoryRecorded`.
    await this.eventBus.subscribeWildcard('HarvestRegulatoryRecorded', this);
    this.logger.log(
      'Subscribed to HarvestRegulatoryRecorded events for harvest traceability notifications (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'HarvestRegulatoryRecorded';
  }

  async handle(event: HarvestRegulatoryRecordedEvent): Promise<HandlerOutcome> {
    // SECURITY: validate tenantId before any per-tenant write.
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        'HarvestRegulatoryRecorded event has invalid or missing tenantId. ' +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return HandlerOutcome.terminate('HarvestRegulatoryRecorded: missing or invalid tenantId');
    }

    // The operator who performed the harvest is the traceability-record owner.
    // Without one there is no in-app recipient — log and skip (the wire event
    // still landed for any future consumer).
    if (!event.harvestedBy) {
      this.logger.warn(
        `HarvestRegulatoryRecorded for batch ${event.batchId} has no harvestedBy — ` +
          'no in-app recipient, skipping notification.',
      );
      return HandlerOutcome.ack();
    }

    const kind = event.isFinal ? 'final' : 'partial';
    const title = `Harvest recorded (${kind})`;
    const body =
      `Harvest of ${event.harvestedQuantity} fish` +
      (event.totalWeight != null ? ` (${event.totalWeight.toFixed(1)}kg)` : '') +
      ` for batch ${event.batchId} was recorded for traceability.`;

    try {
      await this.inAppService.createNotification(event.tenantId, event.harvestedBy, title, body, {
        type: 'HarvestRegulatoryRecorded',
        batchId: event.batchId,
        harvestedQuantity: event.harvestedQuantity,
        totalWeight: event.totalWeight,
        averageWeight: event.averageWeight,
        // ORPHAN-111: event.harvestedAt is now honestly typed as an ISO string
        // (the wire shape), so the defensive Date-or-string ternary is gone.
        harvestedAt: event.harvestedAt,
        isFinal: event.isFinal,
        causationId: event.causationId,
      });
      this.logger.debug(
        `Harvest traceability notification created for batch ${event.batchId} ` +
          `in tenant ${event.tenantId.substring(0, 8)}...`,
      );
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `Error creating harvest traceability notification: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return outcomeForError('HarvestRegulatoryRecorded in-app notification', error);
    }
  }
}
