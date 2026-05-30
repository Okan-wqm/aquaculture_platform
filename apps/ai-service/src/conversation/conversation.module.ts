import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationPrivacyEventHandler } from './conversation-privacy-event.handler';
import { AgentConversation } from './conversation.entity';
import { ConversationService } from './conversation.service';

@Module({
  imports: [TypeOrmModule.forFeature([AgentConversation])],
  providers: [ConversationService, ConversationPrivacyEventHandler],
  exports: [ConversationService],
})
export class ConversationModule {}
