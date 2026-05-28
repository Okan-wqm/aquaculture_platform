import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { ChannelMessageSentEvent } from '@platform/event-contracts';

import { MessagingPushService } from './messaging-push.service';

type ChannelMessageSentPayload = ChannelMessageSentEvent & {
  senderDisplayName?: string;
};

@Injectable()
export class MessagingPushNatsHandler
  implements OnModuleInit, IEventHandler<ChannelMessageSentPayload>
{
  private readonly logger = new Logger(MessagingPushNatsHandler.name);

  constructor(
    private readonly messagingPushService: MessagingPushService,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('ChannelMessageSent', this);
    this.logger.log('Subscribed to durable ChannelMessageSent fanout events');
  }

  getEventType(): string {
    return 'ChannelMessageSent';
  }

  async handleChannelMessageSent(
    payload: ChannelMessageSentPayload,
  ): Promise<void> {
    await this.messagingPushService.handleMessageSent(payload);
  }

  async handle(payload: ChannelMessageSentPayload): Promise<void> {
    await this.handleChannelMessageSent(payload);
  }
}
