import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import {
  AgentRunnerService,
  AiKeyMissingError,
  ChatRequest,
} from '../agent/agent-runner.service';

/**
 * Unified `request.ai.chat` NATS request-reply contract — the SINGLE AI chat
 * entrypoint into ai-service, consumed by BOTH:
 *
 *   - the panel/mobile AI assistant, via the gateway `AiChatGateway` socket.io
 *     bridge (conversation-centric: `message` + `conversationId`), and
 *   - the messaging AI-in-channel bridge (`AiChatBridgeService`), which sends
 *     `content` + channel context (`channelId`/`messageId`/`contextMessages`).
 *
 * This replaces the hand-rolled gateway REST proxy (`routes/v2/ai.routes.ts`) +
 * the SSE `ChatController`: AI chat now rides the same NATS request-reply +
 * socket.io real-time path every other live surface uses (messaging, sensor,
 * st-language), so identity is the HMAC-verified assertion the gateway already
 * threads — no bespoke auth, no path mismatch, no signing gap.
 */
export interface AiChatNatsRequest {
  tenantId: string;
  userId: string;
  /** Assistant surface: the user's prompt. */
  message?: string;
  /** Messaging-bridge alias for `message`. */
  content?: string;
  persona?: string | null;
  conversationId?: string;
  userRoles?: string[];
  /** Faz 7c: the caller's tenant-RBAC grants — authorizes the persona tier. */
  resourcePermissions?: string[];
  correlationId?: string;
  // ── messaging-bridge-only context (ignored by the assistant path) ──
  channelId?: string;
  messageId?: string;
  contextMessages?: Array<{
    senderId: string;
    content: string;
    createdAt: string;
    isAi: boolean;
  }>;
}

export interface AiChatNatsResponse {
  content: string;
  conversationId: string | null;
  metadata: Record<string, unknown> | null;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  /** Present only on failure — callers surface AI_KEY_MISSING distinctly. */
  error?: { code: 'AI_KEY_MISSING' | 'BAD_REQUEST' | 'INTERNAL'; message: string };
}

@Controller()
export class AiChatResponder {
  private readonly logger = new Logger(AiChatResponder.name);

  constructor(private readonly agentRunner: AgentRunnerService) {}

  @MessagePattern('request.ai.chat')
  async handleChat(@Payload() payload: AiChatNatsRequest): Promise<AiChatNatsResponse> {
    const message = (payload.message ?? payload.content ?? '').trim();
    // SEC-HIGH-099 (2026-08-23 scan №44): identity fields are VALIDATED, not
    // trusted — tenantId/userId must be UUIDs (the tenant schema is derived
    // from tenantId, so a malformed value must fail closed BEFORE any
    // schema-derivation or tool execution), and userRoles must be an array
    // of strings. The cert-CN ACL already restricts publishers to gateway
    // and messaging; this closes the payload-trust gap for a compromised
    // publisher.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !UUID_RE.test(payload.tenantId ?? '') ||
      !UUID_RE.test(payload.userId ?? '') ||
      (payload.userRoles !== undefined &&
        (!Array.isArray(payload.userRoles) ||
          payload.userRoles.some((r) => typeof r !== 'string')))
    ) {
      return {
        content: 'The AI request was missing required information.',
        conversationId: null,
        metadata: { errorCode: 'BAD_REQUEST' },
        error: {
          code: 'BAD_REQUEST',
          message: 'tenantId and userId must be UUIDs; userRoles must be string[]',
        },
      };
    }
    if (!message) {
      // `content` carries a user-facing message so the messaging bridge (which
      // posts response.content as the AI reply and does not inspect `error`)
      // degrades gracefully; `error` lets the socket.io assistant emit ai:error.
      return {
        content: 'The AI request was missing required information.',
        conversationId: null,
        metadata: { errorCode: 'BAD_REQUEST' },
        error: { code: 'BAD_REQUEST', message: 'tenantId, userId and a message are required' },
      };
    }

    // Derive the tenant schema the same way the old ChatController did — the
    // agent runner scopes every tool query to it (tenant isolation).
    const cleanId = payload.tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    const chatRequest: ChatRequest = {
      message,
      conversationId: payload.conversationId,
      persona: payload.persona ?? 'operator-v1',
      tenantId: payload.tenantId,
      userId: payload.userId,
      userRoles: payload.userRoles ?? [],
      resourcePermissions: payload.resourcePermissions ?? [],
      schemaName: `tenant_${cleanId}`,
      correlationId: payload.correlationId ?? randomUUID(),
    };

    try {
      const result = await this.agentRunner.chat(chatRequest);
      return {
        content: result.message,
        conversationId: result.conversationId,
        // MOB-HIGH-001: a held actuation rides the metadata in EXACTLY the
        // shape confirmAiAction's lookup expects on the stored AI message
        // (status:'proposed' + actionType/params) plus the actionId that keys
        // the persisted proposal — the executable SSoT on confirm.
        metadata: {
          persona: chatRequest.persona,
          tokenUsage: result.tokenUsage,
          ...(result.proposedAction
            ? {
                status: 'proposed',
                actionId: result.proposedAction.actionId,
                actionType: result.proposedAction.actionType,
                params: result.proposedAction.params,
                actionDescription: result.proposedAction.description,
              }
            : {}),
        },
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      // FAZ1-BYOK: a missing/rejected tenant key is a configuration state, not a
      // server fault — surface AI_KEY_MISSING so the client routes the user to AI
      // settings instead of showing a generic error.
      const isKeyMissing =
        error instanceof AiKeyMissingError ||
        (error as { code?: string })?.code === 'AI_KEY_MISSING';
      if (isKeyMissing) {
        this.logger.warn(`request.ai.chat blocked: tenant ${payload.tenantId} has no valid AI key`);
      } else {
        this.logger.error(
          `request.ai.chat failed for ${payload.tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const userFacing = isKeyMissing
        ? 'No AI API key is configured. Ask a tenant admin to add one in AI settings.'
        : 'The AI is temporarily unavailable. Please try again later.';
      return {
        // Non-empty so the messaging bridge posts a meaningful AI reply; `error`
        // lets the socket.io assistant route the user to AI settings.
        content: userFacing,
        conversationId: null,
        metadata: { errorCode: isKeyMissing ? 'AI_KEY_MISSING' : 'INTERNAL' },
        error: {
          code: isKeyMissing ? 'AI_KEY_MISSING' : 'INTERNAL',
          message: userFacing,
        },
      };
    }
  }
}
