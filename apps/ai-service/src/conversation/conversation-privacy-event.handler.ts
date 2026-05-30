import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type {
  GdprAnonymizeRequestedEvent,
  UserDeletedEvent,
} from '@platform/event-contracts';

import { ConversationService } from './conversation.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PrivacyEvent = UserDeletedEvent | GdprAnonymizeRequestedEvent;

@Injectable()
export class ConversationPrivacyEventHandler
  implements IEventHandler<PrivacyEvent>, OnModuleInit
{
  private readonly logger = new Logger(ConversationPrivacyEventHandler.name);

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly conversationService: ConversationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('UserDeleted', this);
    await this.eventBus.subscribeWildcard('GdprAnonymizeRequested', this);
    this.logger.log('Subscribed to UserDeleted and GdprAnonymizeRequested');
  }

  getEventType(): string {
    return 'ConversationPrivacyEvent';
  }

  async handle(event: PrivacyEvent): Promise<void> {
    if (!UUID_REGEX.test(event.tenantId)) {
      this.logger.error(`Rejected ${event.eventType} with invalid tenantId`);
      return;
    }

    const targetUserId =
      event.eventType === 'UserDeleted' ? event.deletedUserId : event.userId;
    if (!UUID_REGEX.test(targetUserId)) {
      this.logger.error(`Rejected ${event.eventType} with invalid target user id`);
      return;
    }

    const erased = await this.conversationService.eraseForUser(
      event.tenantId,
      targetUserId,
    );
    if (erased > 0) {
      this.logger.log(
        `Erased ${erased} AI conversations for ${event.eventType} target ${targetUserId}`,
      );
    }
  }
}
