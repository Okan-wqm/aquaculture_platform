import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IEventBus } from '@platform/event-bus';
import type { GdprAnonymizeRequestedEvent, UserDeletedEvent } from '@platform/event-contracts';
import { AgentConversation } from './conversation.entity';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ConversationPrivacyEventHandler implements OnModuleInit {
  private readonly logger = new Logger(ConversationPrivacyEventHandler.name);

  constructor(
    @InjectRepository(AgentConversation)
    private readonly conversationRepository: Repository<AgentConversation>,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard<UserDeletedEvent>('UserDeleted', {
      getEventType: () => 'UserDeleted',
      handle: (event) => this.handleUserDeleted(event),
    });
    await this.eventBus.subscribeWildcard<GdprAnonymizeRequestedEvent>('GdprAnonymizeRequested', {
      getEventType: () => 'GdprAnonymizeRequested',
      handle: (event) => this.handleGdprAnonymizeRequested(event),
    });
  }

  private async handleUserDeleted(event: UserDeletedEvent): Promise<void> {
    await this.anonymizeConversations(event.tenantId, event.deletedUserId);
  }

  private async handleGdprAnonymizeRequested(event: GdprAnonymizeRequestedEvent): Promise<void> {
    await this.anonymizeConversations(event.tenantId, event.userId);
  }

  private async anonymizeConversations(tenantId: string, userId: string): Promise<void> {
    if (!UUID_REGEX.test(tenantId) || !UUID_REGEX.test(userId)) {
      this.logger.warn('Rejected AI conversation anonymization with invalid UUID payload');
      return;
    }

    const result = await this.conversationRepository
      .createQueryBuilder()
      .update(AgentConversation)
      .set({
        messages: [
          {
            role: 'system',
            content: '[ANONYMIZED]',
            timestamp: new Date().toISOString(),
          },
        ],
        title: '[ANONYMIZED]',
        totalTokens: 0,
        isActive: false,
      })
      .where('"tenantId" = :tenantId', { tenantId })
      .andWhere('"userId" = :userId', { userId })
      .execute();

    if ((result.affected ?? 0) > 0) {
      this.logger.log(
        `Anonymized ${result.affected} AI conversation(s) for user ${userId.substring(0, 8)}...`,
      );
    }
  }
}
