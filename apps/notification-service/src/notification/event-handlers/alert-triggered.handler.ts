import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler, IEvent } from '@platform/event-bus';
import { createBaseEvent, EventId } from '@platform/event-contracts';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { DeadLetterQueueService } from '../services/dead-letter-queue.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum string lengths for validation
const MAX_RULE_NAME_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_RECIPIENTS = 50;

// Allowed severity values to prevent header injection and ensure data integrity
const ALLOWED_SEVERITIES = ['info', 'low', 'warning', 'medium', 'high', 'critical'];

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
 * Alert Triggered Event interface (v2 — flat fields)
 * Upcaster in NatsEventBus converts v1 nested `triggeringData` to flat `triggerXxx` fields.
 */
interface AlertTriggeredEvent extends IEvent {
  eventId: string | EventId;
  eventType: string;
  timestamp: string;
  tenantId: string;
  alertId: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  message: string;
  channels: string[];
  recipients: string[];
  retryCount?: number;
  triggerSensorId?: string;
  triggerFarmId?: string;
  triggerPondId?: string;
  triggerParameter?: string;
  triggerValue?: number;
  triggerThreshold?: number;
}

/**
 * Alert Triggered Event Handler
 * Listens to alert events and dispatches notifications.
 *
 * Backpressure (L1): A semaphore caps the number of concurrently processed
 * alert events at MAX_EVENT_CONCURRENCY.  NATS may deliver many messages
 * simultaneously after a backlog; without this cap the handler would fan out
 * into an unbounded number of concurrent dispatchAlertNotification() calls,
 * each of which further fans out up to MAX_CONCURRENCY notification sends.
 */
@Injectable()
export class AlertTriggeredEventHandler
  implements IEventHandler<AlertTriggeredEvent>, OnModuleInit
{
  private readonly logger = new Logger(AlertTriggeredEventHandler.name);
  private readonly semaphore = new Semaphore(MAX_EVENT_CONCURRENCY);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    private readonly dlqService: DeadLetterQueueService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Subscribe to alert triggered events
    await this.eventBus.subscribe('AlertTriggered', this);
    this.logger.log('Subscribed to AlertTriggered events');
  }

  getEventType(): string {
    return 'AlertTriggered';
  }

  async handle(event: AlertTriggeredEvent): Promise<void> {
    // SECURITY: Validate tenantId format to ensure data isolation
    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `Alert ${event.alertId} has invalid or missing tenantId. ` +
        'Skipping to prevent cross-tenant notification leakage.',
      );
      return;
    }

    // Validate required fields
    if (!event.alertId || !event.ruleId) {
      this.logger.error(
        `Alert event missing required alertId or ruleId. Skipping.`,
      );
      return;
    }

    this.logger.log(
      `Processing alert ${event.alertId} for tenant ${event.tenantId.substring(0, 8)}...`,
    );

    // Skip if no channels or recipients
    if (!event.channels?.length || !event.recipients?.length) {
      this.logger.warn(
        `Alert ${event.alertId} has no channels or recipients configured`,
      );
      return;
    }

    // Use local copies to avoid mutating the original event
    const recipients = event.recipients.length > MAX_RECIPIENTS
      ? event.recipients.slice(0, MAX_RECIPIENTS)
      : [...event.recipients];

    if (event.recipients.length > MAX_RECIPIENTS) {
      this.logger.warn(
        `Alert ${event.alertId} has too many recipients (${event.recipients.length}). ` +
        `Limiting to first ${MAX_RECIPIENTS}.`,
      );
    }

    // Validate and sanitize severity against allowlist to prevent header injection
    const rawSeverity = (event.severity || 'info').toLowerCase();
    const severity = ALLOWED_SEVERITIES.includes(rawSeverity) ? rawSeverity : 'info';
    if (!ALLOWED_SEVERITIES.includes(rawSeverity)) {
      this.logger.warn(
        `Alert ${event.alertId} has invalid severity "${rawSeverity.substring(0, 50)}". Defaulting to "info".`,
      );
    }

    // Truncate and strip CRLF from strings used in SMTP headers
    const sanitizedRuleName = stripCrlf(
      (event.ruleName || 'Unknown Rule').substring(0, MAX_RULE_NAME_LENGTH),
    );
    const sanitizedMessage = (event.message || '').substring(0, MAX_MESSAGE_LENGTH);

    // Acquire semaphore slot before dispatching to enforce backpressure (L1).
    // If MAX_EVENT_CONCURRENCY events are already in-flight this will queue
    // until one completes, preventing unbounded fan-out under burst delivery.
    await this.semaphore.acquire();

    try {
      await this.dispatcher.dispatchAlertNotification(
        event.tenantId,
        [...event.channels],
        recipients,
        {
          alertId: event.alertId,
          ruleId: event.ruleId,
          ruleName: sanitizedRuleName,
          severity,
          message: sanitizedMessage,
          sensorId: event.triggerSensorId,
          timestamp: new Date(event.timestamp),
        },
      );
    } catch (error) {
      this.logger.error(
        `Error dispatching alert notifications: ${(error as Error).message}`,
        (error as Error).stack,
      );

      // DLQ: Determine whether to retry or dead-letter this event
      try {
        const dlqResult = await this.dlqService.handleFailedEvent(
          { ...event },
          error,
        );

        if (dlqResult.retry) {
          // Re-publish with incremented retryCount and a fresh eventId
          // to bypass NATS deduplication window
          await this.eventBus.publish({
            ...event,
            retryCount: dlqResult.retryCount,
            ...createBaseEvent('AlertTriggered', event.tenantId, { aggregateId: event.alertId, aggregateType: 'Alert' }),
          });
          this.logger.warn(
            `Alert ${event.alertId} re-published for retry attempt ${dlqResult.retryCount}`,
          );
        }
      } catch (dlqError) {
        this.logger.error(
          `DLQ handling failed for alert ${event.alertId}: ${(dlqError as Error).message}`,
        );
      }
    } finally {
      this.semaphore.release();
    }
  }
}
