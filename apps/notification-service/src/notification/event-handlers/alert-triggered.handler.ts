import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum string lengths for validation
const MAX_RULE_NAME_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_RECIPIENTS = 50;

// Allowed severity values to prevent header injection and ensure data integrity
const ALLOWED_SEVERITIES = ['info', 'warning', 'critical'];

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
 * Alert Triggered Event interface
 */
interface AlertTriggeredEvent {
  eventId: string;
  eventType: string;
  timestamp: Date;
  payload: {
    alertId: string;
    ruleId: string;
    ruleName: string;
    tenantId: string;
    severity: string;
    message: string;
    channels: string[];
    recipients: string[];
    triggeringData?: {
      sensorId?: string;
      farmId?: string;
      pondId?: string;
      readings?: Record<string, number>;
    };
  };
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
    const { payload } = event;

    // SECURITY: Validate tenantId format to ensure data isolation
    if (!payload.tenantId || !UUID_REGEX.test(payload.tenantId)) {
      this.logger.error(
        `Alert ${payload.alertId} has invalid or missing tenantId. ` +
        'Skipping to prevent cross-tenant notification leakage.',
      );
      return;
    }

    // Validate required fields
    if (!payload.alertId || !payload.ruleId) {
      this.logger.error(
        `Alert event missing required alertId or ruleId. Skipping.`,
      );
      return;
    }

    this.logger.log(
      `Processing alert ${payload.alertId} for tenant ${payload.tenantId.substring(0, 8)}...`,
    );

    // Skip if no channels or recipients
    if (!payload.channels?.length || !payload.recipients?.length) {
      this.logger.warn(
        `Alert ${payload.alertId} has no channels or recipients configured`,
      );
      return;
    }

    // Use local copies to avoid mutating the original event payload
    const recipients = payload.recipients.length > MAX_RECIPIENTS
      ? payload.recipients.slice(0, MAX_RECIPIENTS)
      : [...payload.recipients];

    if (payload.recipients.length > MAX_RECIPIENTS) {
      this.logger.warn(
        `Alert ${payload.alertId} has too many recipients (${payload.recipients.length}). ` +
        `Limiting to first ${MAX_RECIPIENTS}.`,
      );
    }

    // Validate and sanitize severity against allowlist to prevent header injection
    const rawSeverity = (payload.severity || 'info').toLowerCase();
    const severity = ALLOWED_SEVERITIES.includes(rawSeverity) ? rawSeverity : 'info';
    if (!ALLOWED_SEVERITIES.includes(rawSeverity)) {
      this.logger.warn(
        `Alert ${payload.alertId} has invalid severity "${rawSeverity.substring(0, 50)}". Defaulting to "info".`,
      );
    }

    // Truncate and strip CRLF from strings used in SMTP headers
    const sanitizedRuleName = stripCrlf(
      (payload.ruleName || 'Unknown Rule').substring(0, MAX_RULE_NAME_LENGTH),
    );
    const sanitizedMessage = (payload.message || '').substring(0, MAX_MESSAGE_LENGTH);

    // Acquire semaphore slot before dispatching to enforce backpressure (L1).
    // If MAX_EVENT_CONCURRENCY events are already in-flight this will queue
    // until one completes, preventing unbounded fan-out under burst delivery.
    await this.semaphore.acquire();

    try {
      await this.dispatcher.dispatchAlertNotification(
        payload.tenantId,
        [...payload.channels],
        recipients,
        {
          alertId: payload.alertId,
          ruleId: payload.ruleId,
          ruleName: sanitizedRuleName,
          severity,
          message: sanitizedMessage,
          sensorId: payload.triggeringData?.sensorId,
          timestamp: event.timestamp,
        },
      );
    } catch (error) {
      this.logger.error(
        `Error dispatching alert notifications: ${(error as Error).message}`,
        (error as Error).stack,
      );
    } finally {
      this.semaphore.release();
    }
  }
}
