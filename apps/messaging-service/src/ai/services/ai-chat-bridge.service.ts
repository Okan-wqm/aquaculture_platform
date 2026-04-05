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
import { Injectable, Logger, Inject, ForbiddenException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

import { Message, MessageContentType } from '../../message/entities/message.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';
import { Channel, ChannelType } from '../../channel/entities/channel.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { sanitizeContent } from '../../shared/sanitize';

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
  persona: string | null;
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
    // ChannelMember repo injected for membership verification in confirmAiAction.
    // BEFORE: confirmAiAction executed AI actions without verifying the requesting
    // user is an active member of the channel containing the action message.
    @InjectRepository(ChannelMember)
    private readonly channelMemberRepo: Repository<ChannelMember>,
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
      persona: channel.aiPersona,
      contextMessages,
    };

    // If channel has a custom MCP server URL, try HTTP POST first with NATS fallback
    const response = channel.aiServiceUrl
      ? await this.forwardViaHttpWithFallback(channel.aiServiceUrl, request)
      : await this.forwardViaNats(request, messageId);

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

    // Verify requesting user is an active member of the channel containing the action.
    // BEFORE: no membership check — any authenticated user who obtained the actionMessageId
    // UUID could confirm AI actions in any channel, including ones they had left.
    // Pattern follows channel.service.ts validateChannelAccess() and ForwardMessageHandler:
    // query ChannelMember where channelId + userId + leftAt IS NULL.
    const member = await this.channelMemberRepo.findOne({
      where: {
        channelId: actionMessage.channelId,
        userId,
        leftAt: IsNull(),
      },
    });

    if (!member) {
      throw new ForbiddenException(
        `User ${userId} is not an active member of channel ${actionMessage.channelId}`,
      );
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
      // Sanitize AI response content before storage.
      // BEFORE: response.content stored raw — a prompt injection attack (user crafts
      // a message that causes Claude to output <script>alert(1)</script>) would create
      // stored XSS visible to all channel members.
      // sanitizeContent() is already applied to all user messages (send-message.handler.ts:87,
      // edit-message.handler.ts:46). AI responses must receive the same treatment.
      // NOTE: sanitizeContent strips all HTML; legitimate AI responses are plain text
      // and are not affected.
      const sanitizedContent = sanitizeContent(response.content);

      // Sanitize string values in metadata (tool call results may contain HTML).
      const sanitizedMetadata = response.metadata
        ? Object.fromEntries(
            Object.entries(response.metadata).map(([k, v]) => [
              k,
              typeof v === 'string' ? sanitizeContent(v) : v,
            ]),
          )
        : null;

      const message = manager.create(Message, {
        id: messageId,
        channelId,
        senderId: AI_USER_ID,
        content: sanitizedContent,
        contentType: MessageContentType.SYSTEM,
        parentId: null,
        forwardedFrom: null,
        idempotencyKey: messageId,
        isDeleted: false,
        createdAt: now,
        editedAt: null,
        metadata: sanitizedMetadata,
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

  /**
   * Forward AI chat request via NATS request-reply pattern.
   * Returns a fallback response on failure.
   */
  private async forwardViaNats(
    request: AiChatRequest,
    messageId: string,
  ): Promise<AiChatResponse> {
    const response = await firstValueFrom(
      this.natsClient
        .send<AiChatResponse>('request.ai.chat', request)
        .pipe(
          timeout(AI_CHAT_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`AI chat NATS request failed for ${messageId}: ${errMsg}`);
            return of({
              content: 'AI is temporarily unavailable. Please try again later.',
              metadata: { error: true, fallback: true },
            } satisfies AiChatResponse);
          }),
        ),
    );
    return response;
  }

  /**
   * Forward AI chat request via HTTP POST to a custom MCP server URL.
   * Falls back to NATS if the HTTP request fails.
   *
   * SECURITY: validates that the URL uses HTTPS and does not target private
   * IP ranges (SSRF prevention). Only public HTTPS endpoints are allowed.
   *
   * @param url - Custom MCP server endpoint URL
   * @param request - AI chat request payload
   * @returns AI chat response from the custom server or NATS fallback
   */
  private async forwardViaHttpWithFallback(
    url: string,
    request: AiChatRequest,
  ): Promise<AiChatResponse> {
    // SECURITY: SSRF prevention — only allow HTTPS URLs to public hosts
    if (!this.isSafeExternalUrl(url)) {
      this.logger.warn(
        `Rejected unsafe AI service URL: ${url} (SSRF prevention)`,
      );
      return this.forwardViaNats(request, request.messageId);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), AI_CHAT_TIMEOUT_MS);

      const httpResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!httpResponse.ok) {
        throw new Error(`HTTP ${httpResponse.status}: ${httpResponse.statusText}`);
      }

      const body = (await httpResponse.json()) as AiChatResponse;
      return body;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Custom AI service at ${url} failed (${errMsg}), falling back to NATS`,
      );
      return this.forwardViaNats(request, request.messageId);
    }
  }

  /**
   * Validate that a URL is safe for server-side HTTP requests (SSRF prevention).
   * Rejects private IPs, localhost, non-HTTPS, and link-local addresses.
   */
  private isSafeExternalUrl(url: string): boolean {
    try {
      const parsed = new URL(url);

      // Must be HTTPS
      if (parsed.protocol !== 'https:') {
        return false;
      }

      const hostname = parsed.hostname.toLowerCase();

      // Block localhost and loopback
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname === '0.0.0.0'
      ) {
        return false;
      }

      // Block private/internal IP ranges (RFC 1918, link-local, metadata endpoints)
      const privatePatterns = [
        /^10\./,                      // 10.0.0.0/8
        /^172\.(1[6-9]|2\d|3[0-1])\./, // 172.16.0.0/12
        /^192\.168\./,                // 192.168.0.0/16
        /^169\.254\./,                // link-local / AWS metadata
        /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // CGNAT 100.64.0.0/10
        /^fc[0-9a-f]{2}:/i,          // IPv6 unique local
        /^fe80:/i,                    // IPv6 link-local
      ];

      for (const pattern of privatePatterns) {
        if (pattern.test(hostname)) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }
}
