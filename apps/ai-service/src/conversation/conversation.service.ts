import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  runInTenantRead,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { AgentConversation } from './conversation.entity';

/**
 * ConversationService
 *
 * SECURITY: Every read and write operation requires both tenantId AND userId
 * in the SQL predicate. This makes cross-tenant and cross-user conversation
 * access STRUCTURALLY IMPOSSIBLE at the data-access layer — a caller cannot
 * "forget" to pass ownership context because the method signatures enforce it.
 *
 * Previously, getById/addMessage/updateTokenCount/deactivate used only the
 * conversation UUID, allowing any user who knows a conversation ID to read or
 * mutate another user's conversation history (CRITICAL-001).
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @InjectRepository(AgentConversation)
    private readonly conversationRepo: Repository<AgentConversation>,
    private readonly dataSource: DataSource,
  ) {}

  async create(params: {
    tenantId: string;
    userId: string;
    persona: string;
  }): Promise<AgentConversation> {
    // MSGFIX: NATS callers (request.ai.chat) have no request middleware —
    // agent_conversations is a tenant-schema table and the source-schema write
    // guard rejects unpinned writes (TENANT_ISOLATION_VIOLATION). Pin here so
    // every caller path is uniform; HTTP callers already carry the same pin.
    return runInTenantTransaction(
      this.dataSource,
      'ai',
      params.tenantId,
      async (queryRunner) => {
        const conversation = queryRunner.manager.create(AgentConversation, {
          tenantId: params.tenantId,
          userId: params.userId,
          persona: params.persona,
          messages: [],
          totalTokens: 0,
          isActive: true,
        });
        return queryRunner.manager.save(AgentConversation, conversation);
      },
    );
  }

  /**
   * Append a message to a conversation. Requires tenantId + userId ownership.
   *
   * SECURITY: The WHERE clause includes tenantId and userId so a forged
   * conversationId from another tenant/user results in zero rows updated
   * rather than cross-tenant data mutation.
   *
   * @param conversationId - UUID of the conversation
   * @param tenantId - Caller's tenant UUID (from JWT, never from user input)
   * @param userId - Caller's user UUID (from JWT, never from user input)
   * @param message - The message to append
   */
  async addMessage(
    conversationId: string,
    tenantId: string,
    userId: string,
    message: AgentConversation['messages'][0],
  ): Promise<void> {
    // SECURITY: tenantId + userId in WHERE prevents cross-tenant/cross-user mutation
    // MSGFIX: tenant-schema-pinned (see create()).
    const result = await runInTenantTransaction<unknown>(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) => {
        const rows: unknown = await queryRunner.query(
          `UPDATE agent_conversations SET messages = messages || $1::jsonb, "updatedAt" = NOW() WHERE id = $2 AND "tenantId" = $3 AND "userId" = $4`,
          [JSON.stringify([message]), conversationId, tenantId, userId],
        );
        return rows;
      },
    );
    // result[1] is the affected row count for UPDATE queries
    const affectedRows =
      Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (affectedRows === 0) {
      throw new ForbiddenException(
        'Conversation not found or not owned by current user',
      );
    }
  }

  /**
   * Load a conversation by ID with mandatory tenant + user ownership check.
   *
   * SECURITY: Previously used only { id } in the WHERE clause, allowing any
   * user who knows a conversation UUID to read another user's chat history.
   * Now requires tenantId + userId — returns null when ownership doesn't match.
   *
   * @param id - Conversation UUID
   * @param tenantId - Caller's tenant UUID
   * @param userId - Caller's user UUID
   */
  async getById(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<AgentConversation | null> {
    return runInTenantRead(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.findOne(AgentConversation, {
          where: { id, tenantId, userId },
        }),
    );
  }

  async getRecentByUser(
    tenantId: string,
    userId: string,
    limit = 20,
  ): Promise<AgentConversation[]> {
    return runInTenantRead(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.find(AgentConversation, {
          where: { tenantId, userId },
          order: { updatedAt: 'DESC' },
          take: limit,
        }),
    );
  }

  /**
   * Increment the token count for a conversation. Requires ownership.
   *
   * SECURITY: tenantId + userId in WHERE prevents a rogue caller from
   * inflating another user's token counter (which would block their budget).
   */
  async updateTokenCount(
    conversationId: string,
    tenantId: string,
    userId: string,
    tokens: number,
  ): Promise<void> {
    if (!Number.isInteger(tokens) || tokens < 0) {
      this.logger.warn(`Invalid token count: ${tokens}`);
      return;
    }
    await runInTenantTransaction(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner): Promise<void> => {
        await queryRunner.query(
          `UPDATE agent_conversations SET "totalTokens" = "totalTokens" + $1 WHERE id = $2 AND "tenantId" = $3 AND "userId" = $4`,
          [tokens, conversationId, tenantId, userId],
        );
      },
    );
  }

  /**
   * Deactivate a conversation. Requires ownership.
   */
  async deactivate(
    conversationId: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.update(
          AgentConversation,
          { id: conversationId, tenantId, userId },
          { isActive: false },
        ),
    );
  }

  async eraseForUser(tenantId: string, userId: string): Promise<number> {
    const result = await runInTenantTransaction(
      this.dataSource,
      'ai',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.delete(AgentConversation, { tenantId, userId }),
    );
    return result.affected ?? 0;
  }
}
