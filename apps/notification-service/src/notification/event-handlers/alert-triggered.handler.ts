import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

// UUID v4 regex for tenant ID validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Maximum string lengths for validation
const MAX_RULE_NAME_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_RECIPIENTS = 50;

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
 * Listens to alert events and dispatches notifications
 */
@Injectable()
export class AlertTriggeredEventHandler
  implements IEventHandler<AlertTriggeredEvent>, OnModuleInit
{
  private readonly logger = new Logger(AlertTriggeredEventHandler.name);

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

    // Validate recipients count to prevent abuse
    if (payload.recipients.length > MAX_RECIPIENTS) {
      this.logger.warn(
        `Alert ${payload.alertId} has too many recipients (${payload.recipients.length}). ` +
        `Limiting to first ${MAX_RECIPIENTS}.`,
      );
      payload.recipients = payload.recipients.slice(0, MAX_RECIPIENTS);
    }

    // Truncate potentially long strings
    const sanitizedRuleName = (payload.ruleName || 'Unknown Rule').substring(0, MAX_RULE_NAME_LENGTH);
    const sanitizedMessage = (payload.message || '').substring(0, MAX_MESSAGE_LENGTH);

    try {
      await this.dispatcher.dispatchAlertNotification(
        payload.tenantId,
        payload.channels,
        payload.recipients,
        {
          alertId: payload.alertId,
          ruleId: payload.ruleId,
          ruleName: sanitizedRuleName,
          severity: payload.severity || 'info',
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
    }
  }
}
