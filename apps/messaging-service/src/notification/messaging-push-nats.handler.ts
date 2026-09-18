import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import { MessageSentEvent } from '@platform/event-contracts';

import { MessagingPushService } from './messaging-push.service';

/**
 * Durable consumer that wires `MessageSent` fan-out to push dispatch.
 *
 * WHY (MSG-HIGH-004): `MessagingPushService.handleMessageSent` implements the
 * full content-free push fan-out (sender skip, preference filter, presence
 * skip with @mention override, opaque `notificationRef` + Redis ref store,
 * atomic SETNX dedup, failure-compensating rollback). notification-service's
 * messaging handler explicitly DEFERS channel-message push to messaging-service
 * ("push fan-out is owned by messaging-service"). But NOTHING subscribed
 * `MessagingPushService` to `MessageSent`, and its `onModuleInit` only logged a
 * misleading "listening for MessageSent events" — so the handler was DEAD and
 * offline users received NO push for new channel messages. The opaque-push
 * logic and its content-free guarantee shipped; only the durable subscription
 * was missing.
 *
 * This handler closes the gap with the same `subscribeWildcard` pattern the
 * notification-service messaging handler uses — the platform's live
 * event-consumer pattern. `MessageSent` is already content-free (no body), so
 * no event-contract change is needed; the push payload remains opaque.
 */
@Injectable()
export class MessagingPushNatsHandler implements OnModuleInit, IEventHandler<MessageSentEvent> {
  private readonly logger = new Logger(MessagingPushNatsHandler.name);

  constructor(
    private readonly messagingPushService: MessagingPushService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('MessageSent', this);
    this.logger.log('Subscribed to durable MessageSent fan-out for push dispatch');
  }

  getEventType(): string {
    return 'MessageSent';
  }

  async handle(event: MessageSentEvent): Promise<HandlerOutcome> {
    await this.messagingPushService.handleMessageSent(event);
    return HandlerOutcome.ack();
  }
}
