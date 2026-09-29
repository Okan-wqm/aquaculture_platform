import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HandlerOutcome, IEventBus, IEventHandler, outcomeForError } from '@platform/event-bus';
import {
  checkAlertEscalatedEvent,
  type AlertDeliveryChannel,
  type AlertEscalatedEvent,
} from '@platform/event-contracts';

import { NotificationChannel } from '../entities/notification-log.entity';
import { InAppNotificationService } from '../services/in-app.service';
import { NotificationDispatcherService } from '../services/notification-dispatcher.service';
import { NotificationRateLimitedError } from '../services/notification-rate-limited.error';
import {
  UserContactDirectory,
  UserContactLookupError,
} from '../services/user-contact-directory.service';
import { renderAlertEscalated, type RenderedAlarm } from './alert-escalated.template';

const CHANNEL_OF: Record<AlertDeliveryChannel, NotificationChannel> = {
  push: NotificationChannel.PUSH,
  email: NotificationChannel.EMAIL,
};

/** Why one recipient's delivery attempt did not fully land. */
interface RecipientShortfall {
  inAppFailed: boolean;
  /**
   * A channel send failed in a way a redelivery can fix and nothing else will
   * retry: a transient directory lookup, or a send the tenant rate limit
   * refused (no notification row exists for the retry scheduler to pick up).
   */
  retryableChannel: boolean;
}

/** True when a failed channel send must be re-driven by redelivering the event. */
function isRetryableChannelFailure(error: unknown): boolean {
  if (error instanceof NotificationRateLimitedError) return true;
  return error instanceof UserContactLookupError && error.failureClass === 'transient';
}

/**
 * AlertEscalatedEventHandler — the alarm path's last mile (ALERT-CRITICAL-004).
 *
 * WHY: alert-engine escalated incidents onto `AlertEscalated` and nothing
 * listened, so a critical water-quality, mortality or stock-out incident reached
 * nobody. This consumer turns each escalation into a notification per person.
 *
 * WHAT, per event:
 *   1. Refuse a malformed event at the trust boundary (dead-lettered, reason kept).
 *   2. Ask auth-service — the user directory's owner — who the targets are
 *      (roles tenant-wide / at the incident's site + explicit ids).
 *   3. Per recipient: an in-app notification ALWAYS (the floor channel: it
 *      needs no device and no address), then each policy channel (push via the
 *      user's latest device token, e-mail via auth's PII endpoint), all through
 *      the receipt-backed command dispatcher.
 *
 * IDEMPOTENCY: every write is keyed by `alert-escalated:{eventId}:{userId}[:channel]`
 * — in-app via its delivery-id unique index, push/e-mail via command receipts —
 * so a redelivery re-sends nothing that already landed.
 *
 * FAILURE POLICY: an alarm is `one_shot` (nothing re-raises an escalation), so
 * a failure that a redelivery can fix is RETHROWN: recipient expansion failing
 * transiently, every recipient's in-app write failing, a transient directory
 * lookup for a channel, or a channel send the tenant rate limit refused.
 * Provider failures inside the dispatcher are persisted as FAILED notification
 * rows and retried by its own scheduler. A policy that resolves to nobody is
 * logged at ERROR — retrying cannot conjure a recipient.
 *
 * NATS: consuming the wildcard `events.*.AlertEscalated` needs no services.yaml
 * subscribe row (JetStream consumer via the existing API grants).
 */
@Injectable()
export class AlertEscalatedEventHandler
  implements IEventHandler<AlertEscalatedEvent>, OnModuleInit
{
  private readonly logger = new Logger(AlertEscalatedEventHandler.name);

  constructor(
    @Inject(NotificationDispatcherService)
    private readonly dispatcher: Pick<NotificationDispatcherService, 'dispatchCommandNotification'>,
    @Inject(InAppNotificationService)
    private readonly inApp: Pick<InAppNotificationService, 'createNotification'>,
    @Inject(UserContactDirectory)
    private readonly contacts: Pick<
      UserContactDirectory,
      'alertRecipients' | 'latestPushToken' | 'email'
    >,
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('AlertEscalated', this);
    this.logger.log(
      'Subscribed to AlertEscalated events for alarm delivery (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'AlertEscalated';
  }

  async handle(raw: AlertEscalatedEvent): Promise<HandlerOutcome> {
    const checked = checkAlertEscalatedEvent(raw);
    if (!checked.ok) {
      this.logger.error(`AlertEscalated refused at the trust boundary: ${checked.reason}`);
      return HandlerOutcome.terminate(`AlertEscalated: invalid event (${checked.reason})`);
    }
    const event = checked.value;

    try {
      const recipients = await this.contacts.alertRecipients(event.tenantId, {
        tenantWideRoles: event.tenantWideRecipientRoles,
        siteRoles: event.siteRecipientRoles,
        siteId: event.siteId,
        // The boundary schema admits only distinct user ids here.
        userIds: event.escalatedTo,
      });
      if (recipients.truncated) {
        this.logger.warn(
          `Alarm ${event.alertId}: recipient expansion exceeded the cap; ` +
            `delivering to the first ${recipients.userIds.length}`,
        );
      }
      if (recipients.userIds.length === 0) {
        this.logger.error(
          `Alarm ${event.alertId} (${event.severity}) in tenant ${event.tenantId.substring(0, 8)}... ` +
            'resolved to NO recipient — check the escalation policy targets and site assignments',
        );
        return HandlerOutcome.ack('AlertEscalated: policy targets resolved to no active user');
      }

      const shortfalls: RecipientShortfall[] = [];
      for (const userId of recipients.userIds) {
        shortfalls.push(await this.deliverTo(event, userId));
      }

      if (shortfalls.every((s) => s.inAppFailed)) {
        throw new UserContactLookupError(
          `Alarm ${event.alertId}: in-app delivery failed for all ${shortfalls.length} recipient(s)`,
          'transient',
        );
      }
      if (shortfalls.some((s) => s.retryableChannel)) {
        throw new UserContactLookupError(
          `Alarm ${event.alertId}: a channel send failed transiently (contact lookup or rate limit)`,
          'transient',
        );
      }
      this.logger.log(
        `Alarm ${event.alertId} (${event.severity}, level ${event.escalationLevel}) delivered to ` +
          `${recipients.userIds.length} recipient(s) via in-app${event.channels.map((c) => `+${c}`).join('')}`,
      );
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `AlertEscalated ${event.alertId} delivery failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return outcomeForError(`AlertEscalated ${event.alertId} delivery`, error);
    }
  }

  private async deliverTo(event: AlertEscalatedEvent, userId: string): Promise<RecipientShortfall> {
    const rendered = renderAlertEscalated(event, userId);
    const deliveryId = `alert-escalated:${event.eventId}:${userId}`;
    const shortfall: RecipientShortfall = { inAppFailed: false, retryableChannel: false };

    try {
      await this.inApp.createNotification(
        event.tenantId,
        userId,
        rendered.subject,
        rendered.message,
        {
          type: 'AlertEscalated',
          alertId: event.alertId,
          ruleId: event.ruleId,
          signalKey: event.signalKey,
          severity: event.severity,
          escalationLevel: event.escalationLevel,
          siteId: event.siteId,
        },
        { deliveryId },
      );
    } catch (error) {
      shortfall.inAppFailed = true;
      this.logger.error(
        `Alarm ${event.alertId} in-app write failed for user ${userId.substring(0, 8)}...: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const channel of event.channels) {
      try {
        await this.deliverChannel(event, userId, channel, rendered, `${deliveryId}:${channel}`);
      } catch (error) {
        if (isRetryableChannelFailure(error)) {
          shortfall.retryableChannel = true;
        }
        this.logger.warn(
          `Alarm ${event.alertId} ${channel} delivery to user ${userId.substring(0, 8)}... failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return shortfall;
  }

  private async deliverChannel(
    event: AlertEscalatedEvent,
    userId: string,
    channel: AlertDeliveryChannel,
    rendered: RenderedAlarm,
    deliveryId: string,
  ): Promise<void> {
    let recipient: string;
    if (channel === 'push') {
      const token = await this.contacts.latestPushToken(event.tenantId, userId);
      if (!token) {
        // Not a failure: the user has no registered device; in-app + e-mail carry it.
        this.logger.debug(
          `Alarm ${event.alertId}: user ${userId.substring(0, 8)}... has no device`,
        );
        return;
      }
      recipient = token;
    } else {
      recipient = await this.contacts.email(event.tenantId, userId);
    }

    await this.dispatcher.dispatchCommandNotification({
      tenantId: event.tenantId,
      channel: CHANNEL_OF[channel],
      recipient,
      recipientLogRef: `userId:${userId}`,
      deliveryId,
      requestReference: deliveryId,
      source: 'notification-service.alert-escalated-handler',
      subject: rendered.subject,
      message: rendered.message,
      pushData: channel === 'push' ? rendered.pushData : undefined,
      severity: event.severity,
    });
  }
}
