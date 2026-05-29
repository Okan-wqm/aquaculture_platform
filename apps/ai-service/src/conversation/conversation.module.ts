import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentConversation } from './conversation.entity';
import { ConversationService } from './conversation.service';
import { ConversationPrivacyEventHandler } from './conversation-privacy-event.handler';

@Module({
  imports: [TypeOrmModule.forFeature([AgentConversation])],
  providers: [ConversationService, ConversationPrivacyEventHandler],
  exports: [ConversationService],
})
export class ConversationModule {}
