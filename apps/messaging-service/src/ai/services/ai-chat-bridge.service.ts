/**
 * @module AiChatBridgeService
 * @description Bridges AI channel messages to the ai-service for LLM-powered
 * responses. When a user sends a message in an AI channel (type = 'ai'), the
 * bridge forwards it via NATS request-reply with a 60-second timeout,
 * injecting the CONSENT-FILTERED last messages as context. The AI response is
 * persisted as a message from the virtual AI user, claimed exactly-once in
 * the send-idempotency ledger keyed by the trigger message.
 *
 * MSGFIX-FAZ2 (2026-09-16) hardening:
 *   - EVERY DB access is tenant-pinned (runInTenantRead /
 *     runInTenantTransaction + explicit tenantId predicates) — this service
 *     runs from a JetStream consumer with NO HTTP middleware, and the Faz 1
 *     root cause was exactly this class of unpinned access reading 0 rows
 *     under FORCE RLS.
 *   - Sender authorization is resolved from auth-service over NATS
 *     (request.auth.user.resolveCallerCapabilities, 60s Redis cache,
 *     fail-closed) and `ai_assistant:use` is enforced HERE; roles +
 *     resourcePermissions are forwarded so ai-service can authorize the
 *     persona tier (this replaces the dead
 *     `(channel as {senderRoles?}).senderRoles ?? ['MODULE_USER']` shim —
 *     Channel has no such field, so every turn used to die in
 *     PersonaNotPermittedError).
 *   - Context history is consent-filtered per sender (AiPrivacyService) and
 *     character-budgeted (MESSAGING_AI_CONTEXT_CHAR_BUDGET, default 24k).
 *     conversationId is deliberately NOT sent: a channel-derived
 *     conversationId would collide with ConversationService's per-user
 *     ownership model in multi-user channels and with GDPR eraseForUser.
 *   - The dead prompt-hardening ferry is REMOVED (hardenedSystemPrompt
 *     computation, ToolSchemaValidatorService, persona prompt lookup):
 *     ai-service's own AiSafetyMiddleware chain is the LIVE, authoritative
 *     hardening — messaging must not smuggle a second system prompt.
 *   - Error paths never write the error TEXT as an AI reply: the user gets
 *     one throttled SYSTEM notice (metadata.error=true) instead of
 *     "AI is temporarily unavailable" spam in the channel.
 *
 * Supports the "proposed action" pattern for write tools: AI generates an
 * action card, user confirms via confirmAiAction mutation before execution.
 *
 * @see ADR-012 section 12.4 (AI Chat Bridge)
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, IsNull } from 'typeorm';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { randomUUID as uuidv4 } from 'crypto';
import Redis from 'ioredis';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent } from '@platform/event-contracts';
import { runInTenantRead, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { hasResourcePermission } from '@aquaculture/backend-common/decorators';
import { InputFilterService, OutputPiiScannerService } from '@aquaculture/backend-common/ai-safety';
import { Message, MessageContentType } from '../../message/entities/message.entity';
import { MessageSendIdempotency } from '../../message/entities/message-send-idempotency.entity';
import { Channel, ChannelType } from '../../channel/entities/channel.entity';
import { ChannelMember } from '../../channel/entities/channel-member.entity';
import { sanitizeContent } from '../../shared/sanitize';
import { AI_USER_ID } from '../../shared/ai-user';
import {
  aiReplyLedgerKey,
  aiActionResultLedgerKey,
  aiNoticeLedgerKey,
} from '../../shared/ai-ledger-keys';
import { REDIS_CLIENT } from '../../shared/redis.provider';
import {
  AiCallerCapabilitiesService,
  type CallerCapabilities,
} from './ai-caller-capabilities.service';
import { AiEgressGateService } from './ai-egress-gate.service';
import { AiPrivacyService } from './ai-privacy.service';
import { AiTriggerConfig } from '../ai-trigger.config';

/** NATS request timeout for AI chat: 60 seconds (model inference can be slow). */
const AI_CHAT_TIMEOUT_MS = 60_000;

/** Context messages fetched (pre-filter) per AI request. */
const MAX_CONTEXT_MESSAGES = 30;

/** Throttle window for a channel-level AI unavailability notice. */
const SYSTEM_NOTICE_THROTTLE_SECONDS = 60 * 60;

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
  /** Faz 2.3: the sender's resolved authorization — drives ai-service's
   * persona-tier check (ai_personas:<tier>) instead of the dead local shim. */
  userRoles: string[];
  resourcePermissions: string[];
  /**
   * Faz 2.3 memory: consent-filtered channel history. ai-service maps this
   * to LlmMessage[] history (rızalı diğer kullanıcılar 'user', AI'nın eski
   * yanıtları 'assistant'). conversationId is intentionally NOT set.
   */
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
 * Response from ai-service chat endpoint (ai-chat.responder.ts AiChatNatsResponse).
 */
interface AiChatResponse {
  content: string;
  metadata: Record<string, unknown> | null;
  error?: { code: string; message: string };
}

@Injectable()
export class AiChatBridgeService {
  private readonly logger = new Logger(AiChatBridgeService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly inputFilter: InputFilterService,
    private readonly outputPiiScanner: OutputPiiScannerService,
    private readonly callerCapabilities: AiCallerCapabilitiesService,
    private readonly privacyService: AiPrivacyService,
    private readonly triggerConfig: AiTriggerConfig,
    private readonly egressGate: AiEgressGateService,
    private readonly outboxPublisher: OutboxPublisher,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Handle a new message in an AI channel. Authorizes the sender, fetches
   * consent-filtered context, forwards to ai-service, and persists the AI
   * response as a message from the virtual AI user (exactly once per trigger
   * message).
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
    // Tenant-pinned channel verification (JetStream context — no request
    // middleware pins search_path/RLS for us; runInTenantRead does, and the
    // explicit tenantId predicate is the second defense layer).
    const channel = await runInTenantRead(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager.findOne(Channel, {
          where: { tenantId, id: channelId },
          select: ['id', 'tenantId', 'type', 'aiPersona'],
        }),
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI bridge channel read failed for ${channelId}: ${msg}`);
      return null;
    });

    if (!channel || channel.type !== ChannelType.AI) {
      return;
    }

    // MSG-HIGH-061: route the chat egress through the fail-closed egress gate
    // SSoT (tenant AI master switch + per-user consent). A tenant that
    // disables AI stops chat too; consent uncertainty is denial.
    const egressAllowed = await this.egressGate.isAllowed(tenantId, senderId, 'ai-chat');
    if (!egressAllowed) {
      this.logger.debug(
        `AI chat egress denied for channel ${channelId} (tenant AI disabled or user consent absent) — not forwarding`,
      );
      return;
    }

    // MSGFIX-FAZ2 2.3: authorize the SENDER. The bridge runs without a JWT,
    // so auth-service resolves the caller's capabilities (roles + effective
    // resourcePermissions, 60s Redis cache). Unresolvable → fail closed with
    // ONE throttled system notice — NOT an AI reply, so the channel never
    // fills with "AI is temporarily unavailable" spam.
    const capabilities: CallerCapabilities | null = await this.callerCapabilities.resolve(
      tenantId,
      senderId,
    );
    if (!capabilities) {
      await this.persistSystemNotice(
        tenantId,
        channelId,
        messageId,
        'The AI assistant is currently unavailable. Please try again later.',
        { error: true, errorCode: 'AI_AUTH_UNRESOLVED' },
      );
      return;
    }

    // `ai_assistant:use` gate (admin bypass mirrors the shared SSoT check —
    // SUPER_ADMIN/TENANT_ADMIN carry [] permissions by design).
    if (
      !hasResourcePermission(
        { roles: capabilities.roles, resourcePermissions: capabilities.resourcePermissions },
        'ai_assistant:use',
      )
    ) {
      this.logger.warn(
        `AI chat denied: sender ${senderId} lacks ai_assistant:use in tenant ${tenantId}`,
      );
      await this.persistSystemNotice(
        tenantId,
        channelId,
        messageId,
        'You do not have permission to use the AI assistant in this channel.',
        { error: true, errorCode: 'AI_NOT_PERMITTED' },
      );
      return;
    }

    // SECURITY: Filter input for jailbreak/prompt injection before forwarding
    // to AI. The REPLY-side hardening lives in ai-service's AiSafetyMiddleware
    // (authoritative) — no prompt is ferried from here anymore.
    // @see MSG-CRITICAL-030 (OWASP LLM01:2025 jailbreak defense)
    const filterResult = this.inputFilter.scanInput(content, tenantId);
    if (!filterResult.safe) {
      this.logger.warn(
        `SECURITY: Jailbreak attempt blocked in AI channel ${channelId} by user ${senderId}. ` +
          `Patterns: ${filterResult.flaggedPatterns.join(', ')}`,
      );
      await this.persistAiResponse(tenantId, channelId, aiReplyLedgerKey(messageId), {
        content: 'Your message was flagged by our safety system and cannot be processed.',
        metadata: { type: 'safety_block', reason: 'input_filter', isAi: true },
      });
      return;
    }

    // Faz 2.3 memory: consent-filtered, character-budgeted channel history
    // (trigger message excluded — it travels as `content`).
    const contextMessages = await this.fetchContextMessages(tenantId, channelId, messageId);

    const request: AiChatRequest = {
      tenantId,
      channelId,
      messageId,
      content,
      userId: senderId,
      persona: channel.aiPersona,
      userRoles: capabilities.roles,
      resourcePermissions: capabilities.resourcePermissions,
      contextMessages,
      // SEC-LOW-090 (2026-08-23 scan №35) asked for userRoles/resourcePermissions
      // on this request so ai-service's persona authorization is not dead
      // end-to-end; the Faz 2.3 resolution above (request.auth.user.
      // resolveCallerCapabilities — the sender's REAL roles and capabilities,
      // fail-closed when unresolvable) supersedes its CHANNEL_MEMBER /
      // MODULE_USER fallback.
    };

    // MSG-HIGH-060: AI always runs through ai-service over NATS with the
    // tenant's BYOK key (the per-channel HTTP override was removed — SSRF).
    // ai-service enforces its own tenant quota (60 req/h + token budget) on
    // this path; messaging adds the per-channel daily ceiling in the trigger.
    const response = await this.forwardViaNats(request, messageId);

    if (!response) {
      // Transport failure — one throttled notice, never an AI-styled reply.
      await this.persistSystemNotice(
        tenantId,
        channelId,
        messageId,
        'The AI assistant is currently unavailable. Please try again later.',
        { error: true, errorCode: 'AI_UNAVAILABLE' },
      );
      return;
    }

    // Faz 2.3 error contract: the responder signals failures via
    // `error`/`metadata.errorCode` (AI_KEY_MISSING, rate limit, budget,
    // persona-denied, safety…). The error TEXT is user-facing guidance, but
    // writing it as a NORMAL AI reply would impersonate the assistant — so
    // it rides a throttled SYSTEM notice instead.
    const errorCode = this.responseErrorCode(response);
    if (errorCode) {
      this.logger.warn(
        `AI chat rejected for trigger ${messageId} (code ${errorCode}): ${response.error?.message ?? 'no message'}`,
      );
      await this.persistSystemNotice(tenantId, channelId, messageId, response.content, {
        error: true,
        errorCode,
      });
      return;
    }

    // SECURITY: Scan AI response for PII leakage and redact if detected.
    // @see MSG-HIGH-032 (output PII filter)
    const piiResult = this.outputPiiScanner.redact(response.content, tenantId);
    if (piiResult.scanResult.hasPii) {
      this.logger.warn(`SECURITY: PII detected in AI response for channel ${channelId}, redacting`);
      response.content = piiResult.redactedText;
    }

    // Persist AI response as a message from the virtual AI user — claimed
    // exactly-once per trigger message via the idempotency ledger.
    await this.persistAiResponse(tenantId, channelId, aiReplyLedgerKey(messageId), response);
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
    // Tenant-pinned reads: the action message + the requesting user's ACTIVE
    // membership (leftAt IS NULL) in the action's channel, in ONE read txn.
    const context = await runInTenantRead(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        const actionMessage = await queryRunner.manager.findOne(Message, {
          where: { tenantId, id: actionMessageId, senderId: AI_USER_ID },
        });
        if (!actionMessage) {
          return null;
        }
        const member = await queryRunner.manager.findOne(ChannelMember, {
          where: {
            tenantId,
            channelId: actionMessage.channelId,
            userId,
            leftAt: IsNull(),
          },
          select: ['id', 'tenantId', 'channelId', 'userId'],
        });
        return member ? actionMessage : null;
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI action read failed for ${actionMessageId}: ${msg}`);
      return null;
    });

    if (!context || !context.metadata) {
      this.logger.warn(`AI action message ${actionMessageId} not found`);
      return false;
    }

    const metadata = context.metadata as Record<string, unknown>;
    if (metadata['status'] !== 'proposed') {
      this.logger.warn(`AI action ${actionMessageId} is not in proposed state`);
      return false;
    }

    // Execute the action via NATS. MOB-HIGH-001: `actionId` keys the proposal
    // row ai-service persisted when it held the actuation — the responder
    // executes THAT stored row (tool + params + requester context), so the
    // metadata's actionType/params are an advisory echo, not the executable.
    const response = await firstValueFrom(
      this.natsClient
        .send<{ success: boolean; result: string }>('request.ai.executeAction', {
          tenantId,
          actionId: metadata['actionId'],
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

    // Update action status (tenant-pinned write).
    await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      await queryRunner.manager.update(
        Message,
        { tenantId, id: actionMessageId },
        {
          metadata: {
            ...metadata,
            status: response.success ? 'confirmed' : 'failed',
            confirmedBy: userId,
            executedAt: new Date().toISOString(),
          },
        },
      );
    });

    // Post result as a follow-up system message (exactly-once per action).
    if (response.success) {
      await this.persistAiResponse(
        tenantId,
        context.channelId,
        aiActionResultLedgerKey(actionMessageId),
        {
          content: response.result,
          metadata: { type: 'action_result', sourceActionId: actionMessageId },
        },
      );
    }

    return response.success;
  }

  /**
   * Faz 2.3: one-per-window SYSTEM notice for AI unavailability / denial /
   * daily-ceiling states. Distinct from a real AI reply on every axis the
   * contract exposes: contentType SYSTEM + metadata.error=true +
   * metadata.errorCode, senderId = AI_USER_ID, isAiGenerated=true,
   * MessageSent.isAiResponse=true (so the gateway renders it and push
   * suppresses it). The Redis SETNX throttle bounds it to one notice per
   * channel per window; the DB ledger claim (same key) makes it exactly-once
   * durably.
   */
  async persistSystemNotice(
    tenantId: string,
    channelId: string,
    triggerMessageId: string,
    content: string,
    metadata: Record<string, unknown>,
    throttleWindowSeconds: number = SYSTEM_NOTICE_THROTTLE_SECONDS,
  ): Promise<void> {
    const throttleKey = `msg:ai-notice:${tenantId}:${channelId}`;
    try {
      const claimed = await this.redis.set(
        throttleKey,
        triggerMessageId,
        'EX',
        throttleWindowSeconds,
        'NX',
      );
      if (claimed !== 'OK') {
        this.logger.debug(
          `AI system notice throttled for channel ${channelId} (window ${throttleWindowSeconds}s)`,
        );
        return;
      }
    } catch (err: unknown) {
      // Redis down: notice is best-effort — proceed without the throttle
      // rather than silently swallowing the state change (the durable ledger
      // claim below still prevents duplicate MESSAGES; only the window
      // bounding degrades).
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI notice throttle check failed (${msg})`);
    }

    await this.persistAiResponse(
      tenantId,
      channelId,
      aiNoticeLedgerKey(channelId, triggerMessageId),
      { content, metadata: { ...metadata, isAi: true } },
      { errorNotice: true },
    );
  }

  /**
   * Faz 2.2: the trigger's daily-ceiling notice — throttled to ONE per
   * channel per UTC day by key construction.
   */
  async persistThrottledNotice(
    tenantId: string,
    channelId: string,
    dailyLimit: number,
    dayKey: string,
  ): Promise<void> {
    await this.persistSystemNotice(
      tenantId,
      channelId,
      `daily-limit-${dayKey}`,
      `The daily limit of ${dailyLimit} AI responses for this channel has been reached. The assistant will answer again tomorrow.`,
      { error: true, errorCode: 'AI_DAILY_LIMIT', dailyLimit, dayKey },
    );
  }

  /**
   * Fetch the last N messages from a channel for context injection,
   * CONSENT-FILTERED per sender (Faz 2.3): only messages whose author has an
   * active AI consent are included (plus the AI's own prior replies, which
   * are platform-generated, not user content). A character budget
   * (MESSAGING_AI_CONTEXT_CHAR_BUDGET, default 24k) keeps the newest messages
   * and drops the oldest when exceeded.
   *
   * The TRIGGER message itself is excluded — the responder receives it as
   * `content` (the turn's user message); including it in the history as well
   * would duplicate the prompt and break user/assistant alternation.
   */
  private async fetchContextMessages(
    tenantId: string,
    channelId: string,
    triggerMessageId: string,
  ): Promise<ContextMessage[]> {
    const messages = await runInTenantRead(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) =>
        queryRunner.manager
          .createQueryBuilder(Message, 'm')
          .select(['m.senderId', 'm.content', 'm.createdAt'])
          .where('m."tenantId" = :tenantId', { tenantId })
          .andWhere('m."channelId" = :channelId', { channelId })
          .andWhere('m."id" != :triggerMessageId', { triggerMessageId })
          .andWhere('m."isDeleted" = false')
          .andWhere('m."content" IS NOT NULL')
          .orderBy('m.createdAt', 'DESC')
          .take(MAX_CONTEXT_MESSAGES)
          .getMany(),
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI context fetch failed for ${channelId}: ${msg}`);
      return [] as Message[];
    });

    if (messages.length === 0) {
      return [];
    }

    // Resolve consent per distinct sender (consent read has its own 60s
    // Redis cache, so the fan-out is cheap for repeated senders).
    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    const consentBySender = new Map<string, boolean>();
    await Promise.all(
      senderIds.map(async (senderId) => {
        if (senderId === AI_USER_ID) {
          consentBySender.set(senderId, true); // AI's own turns are not user PII
          return;
        }
        consentBySender.set(
          senderId,
          await this.privacyService.hasUserConsented(tenantId, senderId).catch(() => false),
        );
      }),
    );

    // Chronological order, then apply the character budget from the NEWEST
    // backwards so the freshest context survives truncation.
    const chronological = messages
      .slice()
      .reverse()
      .filter((m) => consentBySender.get(m.senderId) === true)
      .map((m) => ({
        senderId: m.senderId,
        content: m.content ?? '',
        createdAt: m.createdAt.toISOString(),
        isAi: m.senderId === AI_USER_ID,
      }));

    const budget = this.triggerConfig.contextCharBudget;
    const selected: ContextMessage[] = [];
    let used = 0;
    for (let i = chronological.length - 1; i >= 0; i--) {
      const candidate = chronological[i]!;
      if (used + candidate.content.length > budget && selected.length > 0) {
        break;
      }
      selected.unshift(candidate);
      used += candidate.content.length;
    }
    return selected;
  }

  /**
   * Persist an AI response as a new message in the channel.
   *
   * Exactly-once per `ledgerKey` (a deterministic UUIDv5 derived from the
   * trigger identity — see shared/ai-ledger-keys.ts; the column is uuid-typed):
   * the same send-idempotency ledger SendMessageHandler uses is claimed with
   * INSERT ... ON CONFLICT DO NOTHING in the SAME transaction as the message
   * insert. A conflicted claim means this trigger already produced its AI
   * message — skip silently. This survives JetStream redeliveries, pod
   * restarts and Redis outages (the ledger is the authority, Redis is only a
   * cache).
   */
  private async persistAiResponse(
    tenantId: string,
    channelId: string,
    ledgerKey: string,
    response: AiChatResponse,
    options: { errorNotice?: boolean } = {},
  ): Promise<void> {
    const messageId = uuidv4();
    const now = new Date();

    const persisted = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        const { manager } = queryRunner;

        // ── Authoritative exactly-once claim (send-message.handler pattern) ──
        // raw RETURNING (not identifiers) is the only truthful conflict signal.
        const claim = await manager
          .createQueryBuilder()
          .insert()
          .into(MessageSendIdempotency)
          .values({
            tenantId,
            channelId,
            senderId: AI_USER_ID,
            idempotencyKey: ledgerKey,
            messageId,
            messageCreatedAt: now,
          })
          .orIgnore()
          .returning('"messageId"')
          .execute();
        const claimedRows: unknown = claim.raw;
        if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
          return false; // already replied for this trigger — exactly-once holds
        }

        // Sanitize AI response content before storage (stored-XSS guard —
        // sanitizeContent is applied to every user message; AI output is
        // untrusted model output and gets the same treatment).
        const sanitizedContent = sanitizeContent(response.content);

        // Sanitize string values in metadata (tool call results may carry HTML).
        const sanitizedMetadata = response.metadata
          ? Object.fromEntries(
              Object.entries(response.metadata).map(([k, v]) => [
                k,
                typeof v === 'string' ? sanitizeContent(v) : v,
              ]),
            )
          : null;

        // IMPORTANT: isAiGenerated=true for compliance and transparency;
        // metadata.isAi is the in-band stamp for consumers that only see the
        // message row. tenantId is set on every row for RLS + event routing.
        const message = manager.create(Message, {
          id: messageId,
          tenantId,
          channelId,
          senderId: AI_USER_ID,
          content: sanitizedContent,
          contentType: MessageContentType.SYSTEM,
          parentId: null,
          forwardedFrom: null,
          idempotencyKey: ledgerKey,
          isDeleted: false,
          isAiGenerated: true,
          createdAt: now,
          editedAt: null,
          metadata: sanitizedMetadata,
        });
        await manager.save(Message, message);

        // MSGFIX-FAZ2 2.0: isAiResponse is now part of the MessageSent
        // contract (optional, additive) — the gateway validator accepts it,
        // consumers can suppress push / skip re-triggering on it.
        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('MessageSent', tenantId),
            channelId,
            messageId,
            senderId: AI_USER_ID,
            contentType: MessageContentType.SYSTEM,
            hasAttachments: false,
            createdAt: now.toISOString(),
            isAiResponse: true,
            // MSGFIX-FAZ2 (V1 MAJOR-2): notices keep their push exemption so
            // backgrounded users learn the AI turn failed (see contract).
            ...(options.errorNotice ? { isAiErrorNotice: true } : {}),
          },
          manager,
        );
        return true;
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `AI response persist failed for channel ${channelId} (ledger ${ledgerKey}): ${msg}`,
      );
      return false;
    });

    if (persisted) {
      this.logger.debug(`AI response persisted: ${messageId} in channel ${channelId}`);
    }
  }

  /**
   * Forward AI chat request via NATS request-reply pattern.
   * Returns null on transport failure (timeout/unreachable) — the caller
   * turns that into a throttled system notice, NOT a fake AI reply.
   * Application-level failures come back as a response carrying
   * error/metadata.errorCode and are handled by responseErrorCode().
   */
  private async forwardViaNats(
    request: AiChatRequest,
    messageId: string,
  ): Promise<AiChatResponse | null> {
    try {
      return await firstValueFrom(
        this.natsClient.send<AiChatResponse>('request.ai.chat', request).pipe(
          timeout(AI_CHAT_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`AI chat NATS request failed for ${messageId}: ${errMsg}`);
            return of(null);
          }),
        ),
      );
    } catch (err: unknown) {
      // A synchronously-throwing client (not-yet-connected proxy, closed
      // channel) escapes the rxjs pipe — same outcome as a stream error.
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`AI chat NATS dispatch failed for ${messageId}: ${errMsg}`);
      return null;
    }
  }

  /** Extract the responder's failure code, if any (error contract, Faz 2.3). */
  private responseErrorCode(response: AiChatResponse): string | null {
    if (response.error?.code) {
      return response.error.code;
    }
    const metadataCode = response.metadata?.['errorCode'];
    if (typeof metadataCode === 'string' && metadataCode.length > 0) {
      return metadataCode;
    }
    if (response.metadata?.['error'] === true) {
      return 'AI_ERROR';
    }
    return null;
  }

  // MSG-HIGH-060: forwardViaHttpWithFallback + the SsrfValidatorService
  // dependency were removed. That path POSTed the chat request (tenantId + the
  // last 50 context messages) to a member-supplied `aiServiceUrl`. SSRF checks
  // only blocked internal targets, so a member could still exfiltrate the
  // conversation to any public endpoint they controlled. All AI now routes
  // through forwardViaNats → ai-service with the tenant's BYOK key.
}
