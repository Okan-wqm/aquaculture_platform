import { Controller, Logger } from '@nestjs/common';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'crypto';
import {
  AgentRunnerService,
  AiKeyMissingError,
  ChatRequest,
  PersonaConversationMismatchError,
} from '../agent/agent-runner.service';
import { PersonaNotPermittedError } from '../agent/agent-profile.service';
import { UnknownPersonaError } from '../agent/agent-persona-catalogue.service';

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
  /**
   * FARM-AI Sprint 1.2: ephemeral run — no conversation is created or read;
   * the response carries conversationId=null. Service paths (narratives,
   * routines) use this.
   */
  ephemeral?: boolean;
  /**
   * FARM-AI Sprint 1.2: identity of the calling service, checked against the
   * server-side SERVICE_PERSONA_GRANTS map in AgentProfileService. Authority
   * is never taken from the payload.
   */
  serviceId?: string;
  /** FARM-AI Sprint 1.2: allowlisted rate-limit namespace ('routine'). */
  rateNamespace?: string;
  // ── messaging-bridge-only context (ignored by the assistant path) ──
  channelId?: string;
  messageId?: string;
  /**
   * MSGFIX-FAZ2 2.3: consent-filtered channel history (the bridge already
   * dropped non-consenting senders' messages and applied a character
   * budget). Mapped to LlmMessage history below — the responder previously
   * received this field and silently DISCARDED it, so the assistant had no
   * channel memory at all.
   */
  contextMessages?: Array<{
    senderId: string;
    content: string;
    createdAt: string;
    isAi: boolean;
  }>;
}

/** Defensive caps on caller-supplied history (NATS is a trust boundary). */
const MAX_CONTEXT_MESSAGES = 30;
const MAX_CONTEXT_MESSAGE_CHARS = 8_000;

/**
 * Map the bridge's channel context onto provider-neutral chat history.
 *
 * Role mapping: the AI's own prior replies (`isAi`) become 'assistant';
 * every other consented author becomes 'user' (their identity is NOT
 * forwarded — content only). Alternation is enforced downstream
 * (agent-runner's pushAlternating folds consecutive same-role turns), so
 * this stays a pure 1:1 projection.
 */
function mapContextToPriorMessages(
  payload: AiChatNatsRequest,
): Array<{ role: 'user' | 'assistant'; content: string }> | undefined {
  if (!Array.isArray(payload.contextMessages) || payload.contextMessages.length === 0) {
    return undefined;
  }
  const prior: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const ctx of payload.contextMessages.slice(0, MAX_CONTEXT_MESSAGES)) {
    if (typeof ctx?.content !== 'string') continue;
    const text = ctx.content.slice(0, MAX_CONTEXT_MESSAGE_CHARS).trim();
    if (!text) continue;
    prior.push({ role: ctx.isAi === true ? 'assistant' : 'user', content: text });
  }
  return prior.length > 0 ? prior : undefined;
}

export interface AiChatNatsResponse {
  content: string;
  conversationId: string | null;
  metadata: Record<string, unknown> | null;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
  /**
   * Present only on failure — callers surface AI_KEY_MISSING distinctly;
   * BAD_REQUEST = unknown persona / persona-conversation mismatch / missing
   * fields; FORBIDDEN = the caller may not drive the persona.
   */
  error?: { code: 'AI_KEY_MISSING' | 'BAD_REQUEST' | 'FORBIDDEN' | 'INTERNAL'; message: string };
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
        (!Array.isArray(payload.userRoles) || payload.userRoles.some((r) => typeof r !== 'string')))
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
      // null → the tenant default persona (resolved by the runner, never here).
      persona: payload.persona ?? null,
      tenantId: payload.tenantId,
      userId: payload.userId,
      userRoles: payload.userRoles ?? [],
      resourcePermissions: payload.resourcePermissions ?? [],
      schemaName: `tenant_${cleanId}`,
      correlationId: payload.correlationId ?? randomUUID(),
      // FARM-AI Sprint 1.2: service-path fields — identity for the grant map,
      // conversation-less runs, and the namespaced rate counter. All three
      // are ignored (undefined) by the user-chat surfaces.
      ephemeral: payload.ephemeral === true,
      serviceId: payload.serviceId,
      rateNamespace: payload.rateNamespace,
      // MSGFIX-FAZ2 2.3: the bridge's consent-filtered channel context —
      // becomes the model's prior turns (previously ignored, so AI channels
      // had zero memory). Only used when no conversationId rides the request.
      priorMessages: payload.conversationId ? undefined : mapContextToPriorMessages(payload),
    };

    try {
      // TENANT EXECUTION CONTEXT (NATS path): HTTP requests get their
      // AsyncLocalStorage tenant context from RequestContextMiddleware, which
      // the pg pool's connect hook reads to SET search_path per checkout.
      // This NATS handler had NO equivalent — conversation writes survived
      // only because they open their own runInTenant* scopes, while the
      // cost-ledger append (TenantScopedRepository on the pooled connection)
      // checked out a context-less client, landed on the SOURCE ai schema and
      // was rejected by the source-write guard on every turn. Establishing
      // the context here makes the WHOLE turn tenant-routed by construction.
      const result = await withTenantContext(payload.tenantId, () =>
        this.agentRunner.chat(chatRequest),
      );
      return {
        content: result.message,
        conversationId: result.conversationId,
        // MOB-HIGH-001: a held actuation rides the metadata in EXACTLY the
        // shape confirmAiAction's lookup expects on the stored AI message
        // (status:'proposed' + actionType/params) plus the actionId that keys
        // the persisted proposal — the executable SSoT on confirm.
        metadata: {
          // The RESOLVED catalogue id (the request may have named none).
          persona: result.personaId,
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
      // Persona resolution outcomes are caller errors, not server faults:
      // an unknown id / a conversation continued under another persona is a
      // BAD_REQUEST; a persona the caller may not drive is FORBIDDEN. Both
      // carry the exception's own message (no tenant data in it).
      const isBadRequest =
        error instanceof UnknownPersonaError || error instanceof PersonaConversationMismatchError;
      const isForbidden = error instanceof PersonaNotPermittedError;
      if (isKeyMissing) {
        this.logger.warn(`request.ai.chat blocked: tenant ${payload.tenantId} has no valid AI key`);
      } else if (isBadRequest || isForbidden) {
        this.logger.warn(
          `request.ai.chat rejected for ${payload.tenantId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        this.logger.error(
          `request.ai.chat failed for ${payload.tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const code: NonNullable<AiChatNatsResponse['error']>['code'] = isKeyMissing
        ? 'AI_KEY_MISSING'
        : isBadRequest
          ? 'BAD_REQUEST'
          : isForbidden
            ? 'FORBIDDEN'
            : 'INTERNAL';
      const userFacing = isKeyMissing
        ? 'No AI API key is configured. Ask a tenant admin to add one in AI settings.'
        : isBadRequest || isForbidden
          ? (error as Error).message
          : 'The AI is temporarily unavailable. Please try again later.';
      return {
        // Non-empty so the messaging bridge posts a meaningful AI reply; `error`
        // lets the socket.io assistant route the user to AI settings.
        content: userFacing,
        conversationId: null,
        metadata: { errorCode: code },
        error: { code, message: userFacing },
      };
    }
  }
}
