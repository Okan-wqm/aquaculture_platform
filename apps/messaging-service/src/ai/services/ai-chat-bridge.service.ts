/**
 * @module AiChatBridgeService
 * @description Bridges AI channel messages to the ai-service for LLM-powered
 * responses. When a user sends a message in an AI channel (type = 'ai'),
 * the bridge forwards it via NATS request-reply with 60-second timeout,
 * injecting the last 50 messages as context. The AI response is persisted
 * as a message from a virtual AI user.
 *
 * Supports the "proposed action" pattern for write tools: AI generates an
 * action card, user confirms via confirmAiAction mutation before execution.
 *
 * @see ADR-012 section 12.4 (AI Chat Bridge)
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { Message, MessageContentType } from '../../message/entities/message.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { Channel, ChannelType } from '../../channel/entities/channel.entity';

/** Virtual AI user UUID -- consistent across all tenants. */
const AI_USER_ID = '00000000-0000-0000-0000-000000000001';

/** NATS request timeout for AI chat: 60 seconds (model inference can be slow). */
const AI_CHAT_TIMEOUT_MS = 60_000;

/** Maximum context messages to include in the AI prompt. */
const MAX_CONTEXT_MESSAGES = 50;

/**
 * Request payload sent to ai-service for chat completion.
 */
interface AiChatRequest {
  tenantId: string;
  channelId: string;
  messageId: string;
  content: string;
  userId: string;
  contextMessages: ContextMessage[];
}

/**
 * Simplified message for context injection.
 */
interface ContextMessage {
  senderId: string;
  content: string;
  createdAt: string;
  isAi: boolean;
}

/**
 * Response from ai-service chat endpoint.
 */
interface AiChatResponse {
  content: string;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class AiChatBridgeService {
  private readonly logger = new Logger(AiChatBridgeService.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  /**
   * Handle a new message in an AI channel. Fetches context, forwards to
   * ai-service, and persists the AI response as a message.
   *
   * @param tenantId - Tenant identifier
   * @param channelId - AI channel identifier
   * @param messageId - The triggering message UUID
   * @param content - Message text content
   * @param senderId - User who sent the message
   */
  async handleAiChannelMessage(
    tenantId: string,
    channelId: string,
    messageId: string,
    content: string,
    senderId: string,
  ): Promise<void> {
    // Verify this is actually an AI channel
    const channel = await this.channelRepo.findOne({
      where: { id: channelId },
    });

    if (!channel || channel.type !== ChannelType.AI) {
      return;
    }

    // Fetch context: last N messages from this channel
    const contextMessages = await this.fetchContextMessages(channelId);

    const request: AiChatRequest = {
      tenantId,
      channelId,
      messageId,
      content,
      userId: senderId,
      contextMessages,
    };

    // Forward to ai-service via NATS with 60s timeout
    const response = await firstValueFrom(
      this.natsClient
        .send<AiChatResponse>('request.ai.chat', request)
        .pipe(
          timeout(AI_CHAT_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`AI chat request failed for ${messageId}: ${errMsg}`);
            return of({
              content: 'AI is temporarily unavailable. Please try again later.',
              metadata: { error: true, fallback: true },
            } satisfies AiChatResponse);
          }),
        ),
    );

    if (!response) {
      return;
    }

    // Persist AI response as a message from the virtual AI user
    await this.persistAiResponse(tenantId, channelId, response);
  }

  /**
   * Confirm and execute a proposed AI action (human-in-the-loop pattern).
   * Validates the action exists, marks it as confirmed, and executes via NATS.
   *
   * @param tenantId - Tenant identifier
   * @param actionMessageId - UUID of the message containing the proposed action
   * @param userId - User confirming the action
   * @returns true if action was executed successfully
   */
  async confirmAiAction(
    tenantId: string,
    actionMessageId: string,
    userId: string,
  ): Promise<boolean> {
    // Find the action message
    const actionMessage = await this.messageRepo.findOne({
      where: { id: actionMessageId, senderId: AI_USER_ID },
    });

    if (!actionMessage || !actionMessage.metadata) {
      this.logger.warn(`AI action message ${actionMessageId} not found`);
      return false;
    }

    const metadata = actionMessage.metadata as Record<string, unknown>;
    if (metadata['status'] !== 'proposed') {
      this.logger.warn(`AI action ${actionMessageId} is not in proposed state`);
      return false;
    }

    // Execute the action via NATS
    const response = await firstValueFrom(
      this.natsClient
        .send<{ success: boolean; result: string }>('request.ai.executeAction', {
          tenantId,
          actionType: metadata['actionType'],
          params: metadata['params'],
          confirmedBy: userId,
        })
        .pipe(
          timeout(AI_CHAT_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`AI action execution failed: ${errMsg}`);
            return of({ success: false, result: 'Action execution failed' });
          }),
        ),
    );

    if (!response) {
      return false;
    }

    // Update action status
    await this.messageRepo.update(
      { id: actionMessageId },
      {
        metadata: {
          ...metadata,
          status: response.success ? 'confirmed' : 'failed',
          confirmedBy: userId,
          executedAt: new Date().toISOString(),
        },
      },
    );

    // Post result as a follow-up system message
    if (response.success) {
      await this.persistAiResponse(tenantId, actionMessage.channelId, {
        content: response.result,
        metadata: { type: 'action_result', sourceActionId: actionMessageId },
      });
    }

    return response.success;
  }

  /**
   * Fetch the last N messages from a channel for context injection.
   */
  private async fetchContextMessages(
    channelId: string,
  ): Promise<ContextMessage[]> {
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .select(['m.senderId', 'm.content', 'm.createdAt'])
      .where('m."channelId" = :channelId', { channelId })
      .andWhere('m."isDeleted" = false')
      .andWhere('m."content" IS NOT NULL')
      .orderBy('m."createdAt"', 'DESC')
      .take(MAX_CONTEXT_MESSAGES)
      .getMany();

    // Reverse to chronological order
    return messages.reverse().map((m) => ({
      senderId: m.senderId,
      content: m.content ?? '',
      createdAt: m.createdAt.toISOString(),
      isAi: m.senderId === AI_USER_ID,
    }));
  }

  /**
   * Persist an AI response as a new message in the channel.
   * Uses a transaction with outbox event for guaranteed delivery.
   */
  private async persistAiResponse(
    tenantId: string,
    channelId: string,
    response: AiChatResponse,
  ): Promise<void> {
    const messageId = uuidv4();
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      const message = manager.create(Message, {
        id: messageId,
        channelId,
        senderId: AI_USER_ID,
        content: response.content,
        contentType: MessageContentType.SYSTEM,
        parentId: null,
        forwardedFrom: null,
        idempotencyKey: messageId,
        isDeleted: false,
        createdAt: now,
        editedAt: null,
        metadata: response.metadata ?? null,
      });
      await manager.save(Message, message);

      const outbox = manager.create(MessagingOutbox, {
        eventType: 'MessageSent',
        payload: {
          eventId: uuidv4(),
          tenantId,
          channelId,
          messageId,
          senderId: AI_USER_ID,
          contentType: MessageContentType.SYSTEM,
          hasAttachments: false,
          createdAt: now.toISOString(),
          isAiResponse: true,
        },
      });
      await manager.save(MessagingOutbox, outbox);
    });

    this.logger.debug(`AI response persisted: ${messageId} in channel ${channelId}`);
  }
}
