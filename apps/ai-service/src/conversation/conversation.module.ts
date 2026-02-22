import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentConversation } from './conversation.entity';
import { ConversationService } from './conversation.service';

@Module({
  imports: [TypeOrmModule.forFeature([AgentConversation])],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
