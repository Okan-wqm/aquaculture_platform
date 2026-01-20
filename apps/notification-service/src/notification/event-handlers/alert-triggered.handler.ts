import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';

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

    this.logger.log(
      `Processing alert ${payload.alertId} for tenant ${payload.tenantId}`,
    );

    // Skip if no channels or recipients
    if (!payload.channels?.length || !payload.recipients?.length) {
      this.logger.warn(
        `Alert ${payload.alertId} has no channels or recipients configured`,
      );
      return;
    }

    try {
      await this.dispatcher.dispatchAlertNotification(
        payload.tenantId,
        payload.channels,
        payload.recipients,
        {
          alertId: payload.alertId,
          ruleId: payload.ruleId,
          ruleName: payload.ruleName,
          severity: payload.severity,
          message: payload.message,
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
