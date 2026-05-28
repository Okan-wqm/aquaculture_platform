import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { ChannelMessageSentEvent } from '@platform/event-contracts';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';

import { Message, MessageContentType } from '../../message/entities/message.entity';
import { AnalyzeMessageCommand } from '../commands/analyze-message.command';

@Injectable()
export class ChannelMessageSentAiConsumer
  implements OnModuleInit, IEventHandler<ChannelMessageSentEvent>
{
  private readonly logger = new Logger(ChannelMessageSentAiConsumer.name);

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
    private readonly dataSource: DataSource,
    private readonly commandBus: CommandBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('ChannelMessageSent', this);
    this.logger.log('Subscribed to durable ChannelMessageSent AI events');
  }

  getEventType(): string {
    return 'ChannelMessageSent';
  }

  async handle(event: ChannelMessageSentEvent): Promise<void> {
    if (event.isAiResponse) {
      return;
    }

    const message = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      event.tenantId,
      async (queryRunner) =>
        queryRunner.manager.findOne(Message, {
          where: {
            tenantId: event.tenantId,
            id: event.messageId,
            channelId: event.channelId,
            isDeleted: false,
          },
        }),
    );

    if (!message?.content || message.contentType !== MessageContentType.TEXT) {
      return;
    }

    await this.commandBus.execute(
      new AnalyzeMessageCommand(
        event.tenantId,
        event.channelId,
        message.id,
        message.createdAt,
        message.senderId,
        message.content,
      ),
    );
  }
}
