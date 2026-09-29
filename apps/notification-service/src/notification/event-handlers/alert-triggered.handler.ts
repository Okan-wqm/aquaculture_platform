import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome, outcomeForError } from '@platform/event-bus';
import type { AlertSeverityLevel, AlertTriggeredEvent } from '@platform/event-contracts';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { declaresTransient } from '../services/declares-transient';
import {
  externalDeliveryKey,
  externalDeliveryPayloadHash,
  splitExternalTargets,
  type ExternalDelivery,
} from './alert-triggered-targets';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum string lengths for validation
const MAX_RULE_NAME_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_RECIPIENTS = 50;

// Allowed severity values to prevent header injection and ensure data integrity
const ALLOWED_SEVERITIES: readonly AlertSeverityLevel[] = [
  'info',
  'low',
  'warning',
  'medium',
  'high',
  'critical',
];

function isAllowedSeverity(value: string): value is AlertSeverityLevel {
  return (ALLOWED_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Maximum number of alert events processed concurrently (L1 backpressure).
 * Regardless of how many NATS messages are delivered simultaneously, at most
 * this many dispatchAlertNotification() calls will be in flight at once.
 * Each dispatch internally caps at MAX_CONCURRENCY (10) notification sends,
 * so the total concurrent DB/SMTP operations is bounded at
 * MAX_EVENT_CONCURRENCY * 10 = 50.
 */
const MAX_EVENT_CONCURRENCY = 5;

/**
 * Minimal async semaphore – caps concurrent executions without an external dep.
 */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.active--;
    if (this.queue.length > 0 && this.active < this.limit) {
      this.active++;
      const next = this.queue.shift()!;
      next();
    }
  }
}

/**
 * Strip CRLF characters from strings destined for SMTP headers
 */
function stripCrlf(str: string): string {
  return str.replace(/[\r\n]/g, '');
}

/**
 * Alert Triggered Event Handler — a sensor rule's EXTERNAL targets (decision 7).
 *
 * WHY this changed: a sensor-rule incident was paged twice — to the rule's
 * recipients from this event and to the policy's people from its escalation
 * (`AlertEscalated`), under two unrelated dedup keys (V-S1a-7). People now
 * have ONE pager, the escalation (the rule's user-id recipients join its level
 * 1), and this handler delivers only what escalation cannot: the rule's raw
 * e-mail addresses, phone numbers and webhook URLs.
 *
 * WHAT, per event:
 *   - user-id recipients are skipped (escalation pages them);
 *   - each external address goes out over the one channel its form names, if
 *     the rule lists that channel (`splitExternalTargets`);
 *   - every send is receipt-backed and keyed by the INCIDENT + channel +
 *     target (`externalDeliveryKey`), with a payload hash of that same key — a
 *     later trigger that only bumps the open incident, or a redelivery, sends
 *     nothing new;
 *   - CRITICAL/HIGH sends are exempt from the tenant rate limit, and a failure
 *     that declares itself transient re-drives the event on the life-safety
 *     budget (applied by the bus to this event type).
 *
 * Backpressure (L1): a semaphore caps concurrently processed events.
 */
@Injectable()
export class AlertTriggeredEventHandler
  implements IEventHandler<AlertTriggeredEvent>, OnModuleInit
{
  private readonly logger = new Logger(AlertTriggeredEventHandler.name);
  private readonly semaphore = new Semaphore(MAX_EVENT_CONCURRENCY);

  constructor(
    @Inject(NotificationDispatcherService)
    private readonly dispatcher: Pick<NotificationDispatcherService, 'dispatchCommandNotification'>,
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
  ) {}

  async onModuleInit(): Promise<void> {
    // `events.*.AlertTriggered` — one notification-service serves every tenant.
    await this.eventBus.subscribeWildcard('AlertTriggered', this);
    this.logger.log('Subscribed to AlertTriggered events (cross-tenant wildcard)');
  }

  getEventType(): string {
    return 'AlertTriggered';
  }

  async handle(event: AlertTriggeredEvent): Promise<HandlerOutcome> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `Alert ${event.alertId} has invalid or missing tenantId. ` +
          'Skipping to prevent cross-tenant notification leakage.',
      );
      return HandlerOutcome.terminate('AlertTriggered: missing or invalid tenantId');
    }
    if (!event.alertId || !event.ruleId || !event.incidentId) {
      this.logger.error('AlertTriggered event missing alertId, ruleId or incidentId. Skipping.');
      return HandlerOutcome.terminate('AlertTriggered: missing alertId, ruleId or incidentId');
    }

    const split = splitExternalTargets(event.recipients ?? [], event.channels ?? []);
    if (split.unreachable > 0) {
      this.logger.warn(
        `Alert ${event.alertId}: ${split.unreachable} rule recipient(s) are neither a user id nor ` +
          "an address reachable over one of the rule's channels — not delivered",
      );
    }
    if (split.deliveries.length === 0) {
      return HandlerOutcome.ack(
        split.userIds > 0
          ? 'AlertTriggered: the rule names only people — its incident escalation pages them'
          : undefined,
      );
    }
    const deliveries =
      split.deliveries.length > MAX_RECIPIENTS
        ? split.deliveries.slice(0, MAX_RECIPIENTS)
        : split.deliveries;
    if (split.deliveries.length > MAX_RECIPIENTS) {
      this.logger.warn(
        `Alert ${event.alertId} has too many external targets (${split.deliveries.length}). ` +
          `Limiting to first ${MAX_RECIPIENTS}.`,
      );
    }

    // Validate and sanitize severity against allowlist to prevent header injection
    const rawSeverity = (event.severity || 'info').toLowerCase();
    const severity = isAllowedSeverity(rawSeverity) ? rawSeverity : 'info';
    const subject = stripCrlf(
      (event.ruleName || 'Unknown Rule').substring(0, MAX_RULE_NAME_LENGTH),
    );
    const message = (event.message || '').substring(0, MAX_MESSAGE_LENGTH);

    await this.semaphore.acquire();
    try {
      let transient: unknown = null;
      for (const delivery of deliveries) {
        try {
          await this.deliver(event, delivery, severity, subject, message);
        } catch (error) {
          if (!declaresTransient(error)) {
            this.logger.warn(
              `Alert ${event.alertId} ${delivery.channel} delivery failed permanently: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          transient ??= error;
        }
      }
      if (transient !== null) {
        return outcomeForError(`AlertTriggered ${event.alertId} external delivery`, transient);
      }
      return HandlerOutcome.ack();
    } finally {
      this.semaphore.release();
    }
  }

  private async deliver(
    event: AlertTriggeredEvent,
    delivery: ExternalDelivery,
    severity: AlertSeverityLevel,
    subject: string,
    message: string,
  ): Promise<void> {
    const key = externalDeliveryKey(event.incidentId, delivery);
    await this.dispatcher.dispatchCommandNotification({
      tenantId: event.tenantId,
      channel: delivery.channel,
      recipient: delivery.address,
      deliveryId: key,
      requestReference: key,
      // The payload hash is derived from the KEY, not the message: a bump
      // carries a new message for the same incident target and must replay the
      // receipt, not conflict with it.
      commandPayloadHash: externalDeliveryPayloadHash(key),
      source: 'notification-service.alert-triggered-handler',
      subject,
      message,
      severity,
      lifeSafetyAlarm: severity === 'critical' || severity === 'high',
    });
  }
}
