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
import { randomUUID as uuidv4 } from 'crypto';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { Message, MessageContentType } from '../../message/entities/message.entity';
import { Channel, ChannelType } from '../../channel/entities/channel.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { sanitizeContent } from '../../shared/sanitize';
import {
  InputFilterService,
  OutputPiiScannerService,
} from '@aquaculture/backend-common/ai-safety';
import { InstructionHierarchyService } from '../safety/instruction-hierarchy.service';
import { ToolSchemaValidatorService } from '../safety/tool-schema-validator.service';
import { AiPersonasRegistryService } from './ai-personas-registry.service';
import { AiEgressGateService } from './ai-egress-gate.service';

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
    private readonly inputFilter: InputFilterService,
    private readonly outputPiiScanner: OutputPiiScannerService,
    private readonly instructionHierarchy: InstructionHierarchyService,
    private readonly toolSchemaValidator: ToolSchemaValidatorService,
    private readonly personasRegistry: AiPersonasRegistryService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly egressGate: AiEgressGateService,
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

    // MSG-HIGH-061: route the chat egress through the fail-closed egress gate
    // SSoT (the same boundary sentiment/embedding use, with the pre-declared
    // 'ai-chat' purpose). This enforces BOTH the tenant AI master switch AND
    // per-user consent — canAnalyzeMessage = isTenantAiEnabled AND
    // hasUserConsented — and treats a consent-resolution error as denial. The
    // gate lives here, at the single AI-chat egress point, so no caller (the
    // handler forwards unconditionally) can bypass it. A tenant that disables
    // AI now stops chat too; previously the chat path ignored the switch.
    const egressAllowed = await this.egressGate.isAllowed(
      tenantId,
      senderId,
      'ai-chat',
    );
    if (!egressAllowed) {
      this.logger.debug(
        `AI chat egress denied for channel ${channelId} (tenant AI disabled or user consent absent) — not forwarding`,
      );
      return;
    }

    // SECURITY: Filter input for jailbreak/prompt injection before forwarding to AI.
    // @see MSG-CRITICAL-030 (OWASP LLM01:2025 jailbreak defense)
    const filterResult = this.inputFilter.scanInput(content, tenantId);
    if (!filterResult.safe) {
      this.logger.warn(
        `SECURITY: Jailbreak attempt blocked in AI channel ${channelId} by user ${senderId}. ` +
        `Patterns: ${filterResult.flaggedPatterns.join(', ')}`,
      );
      await this.persistAiResponse(tenantId, channelId, {
        content: 'Your message was flagged by our safety system and cannot be processed.',
        metadata: { type: 'safety_block', reason: 'input_filter' },
      });
      return;
    }

    // Fetch context: last N messages from this channel
    const contextMessages = await this.fetchContextMessages(channelId);

    // SECURITY: Build hardened system prompt with instruction hierarchy.
    // Prevents user messages from overriding system-level directives.
    // @see MSG-HIGH-031 (instruction hierarchy)
    // @see MSG-HIGH-036 (custom system prompt injection)
    const personaName = channel.aiPersona ?? 'Aquaculture Assistant';
    const baseSystemPrompt = this.personasRegistry.getPersonaSystemPrompt(personaName);
    // NOTE: Tenant custom prompts are validated by InstructionHierarchyService.
    // Prompts containing injection patterns are rejected and logged.
    const hardenedSystemPrompt = this.instructionHierarchy.buildHardenedSystemPrompt(
      personaName,
      baseSystemPrompt,
      undefined, // Tenant custom prompt passed via separate config, not inline
    );

    const request: AiChatRequest = {
      tenantId,
      channelId,
      messageId,
      content,
      userId: senderId,
      persona: channel.aiPersona,
      contextMessages,
    };

    // MSG-HIGH-060: AI always runs through ai-service over NATS with the
    // tenant's BYOK key. The per-channel HTTP override was removed — it let a
    // member exfiltrate conversation context + tenantId to an arbitrary public
    // endpoint (SSRF checks only blocked internal targets, not exfiltration).
    const response = await this.forwardViaNats(request, messageId);

    if (!response) {
      return;
    }

    // SECURITY: Scan AI response for PII leakage and redact if detected.
    // @see MSG-HIGH-032 (output PII filter)
    const piiResult = this.outputPiiScanner.redact(response.content, tenantId);
    if (piiResult.scanResult.hasPii) {
      this.logger.warn(
        `SECURITY: PII detected in AI response for channel ${channelId}, redacting`,
      );
      response.content = piiResult.redactedText;
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
      .orderBy('m.createdAt', 'DESC')
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

      // IMPORTANT: Set isAiGenerated=true for compliance and transparency.
      // Users must be able to distinguish AI-generated content from human messages.
      // @see MSG-MEDIUM-038 (AI message attribution)
      // SECURITY: tenantId MUST be set on every message row for RLS and event routing.
      const message = manager.create(Message, {
        id: messageId,
        tenantId,
        channelId,
        senderId: AI_USER_ID,
        content: sanitizedContent,
        contentType: MessageContentType.SYSTEM,
        parentId: null,
        forwardedFrom: null,
        idempotencyKey: messageId,
        isDeleted: false,
        isAiGenerated: true,
        createdAt: now,
        editedAt: null,
        metadata: sanitizedMetadata,
      });
      await manager.save(Message, message);

      await this.outboxPublisher.enqueue({
        ...createBaseEvent('MessageSent', tenantId),
        channelId,
        messageId,
        senderId: AI_USER_ID,
        contentType: MessageContentType.SYSTEM,
        hasAttachments: false,
        createdAt: now.toISOString(),
        isAiResponse: true,
      },  manager);
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

  // MSG-HIGH-060: forwardViaHttpWithFallback + the SsrfValidatorService
  // dependency were removed. That path POSTed the chat request (tenantId + the
  // last 50 context messages) to a member-supplied `aiServiceUrl`. SSRF checks
  // only blocked internal targets, so a member could still exfiltrate the
  // conversation to any public endpoint they controlled. All AI now routes
  // through forwardViaNats → ai-service with the tenant's BYOK key.
}
