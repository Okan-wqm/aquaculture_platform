import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentConversation } from './conversation.entity';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @InjectRepository(AgentConversation)
    private readonly conversationRepo: Repository<AgentConversation>,
  ) {}

  async create(params: {
    tenantId: string;
    userId: string;
    persona: string;
  }): Promise<AgentConversation> {
    const conversation = this.conversationRepo.create({
      tenantId: params.tenantId,
      userId: params.userId,
      persona: params.persona,
      messages: [],
      totalTokens: 0,
      isActive: true,
    });
    return this.conversationRepo.save(conversation);
  }

  async addMessage(
    conversationId: string,
    message: AgentConversation['messages'][0],
  ): Promise<void> {
    // Use parameterized query to prevent SQL injection via message content
    await this.conversationRepo.query(
      `UPDATE agent_conversations SET messages = messages || $1::jsonb, "updatedAt" = NOW() WHERE id = $2`,
      [JSON.stringify([message]), conversationId],
    );
  }

  async getById(id: string): Promise<AgentConversation | null> {
    return this.conversationRepo.findOne({ where: { id } });
  }

  async getRecentByUser(
    tenantId: string,
    userId: string,
    limit = 20,
  ): Promise<AgentConversation[]> {
    return this.conversationRepo.find({
      where: { tenantId, userId },
      order: { updatedAt: 'DESC' },
      take: limit,
    });
  }

  async updateTokenCount(
    conversationId: string,
    tokens: number,
  ): Promise<void> {
    // Use parameterized query to prevent SQL injection
    if (!Number.isInteger(tokens) || tokens < 0) {
      this.logger.warn(`Invalid token count: ${tokens}`);
      return;
    }
    await this.conversationRepo.query(
      `UPDATE agent_conversations SET "totalTokens" = "totalTokens" + $1 WHERE id = $2`,
      [tokens, conversationId],
    );
  }

  async deactivate(conversationId: string): Promise<void> {
    await this.conversationRepo.update(conversationId, { isActive: false });
  }
}
