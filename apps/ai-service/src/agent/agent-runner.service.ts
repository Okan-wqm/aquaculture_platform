import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { ActionProposalService } from '../actions/action-proposal.service';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ToolExecutorService } from '../tools/core/tool-executor.service';
import { AgentProfileService } from './agent-profile.service';
import { ConversationService } from '../conversation/conversation.service';
import { TokenBudgetService } from '../cost/token-budget.service';
import { RateLimitService } from '../cost/rate-limit.service';
import { TurnLedgerService } from '../cost/turn-ledger.service';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolExecutionContext } from '../tools/core/tool.interface';
import { AiSafetyMiddleware } from '../safety/ai-safety.middleware';
import { LlmProviderFactory } from './providers/llm-provider.factory';
import {
  LlmAuthError,
  LlmContentBlock,
  LlmMessage,
  LlmToolDefinition,
} from './providers/llm-provider.interface';

/**
 * Thrown when a tenant has no usable credential for their selected provider, or
 * the stored key is rejected by the provider. The controller maps this to a
 * distinct AI_KEY_MISSING response so the UI can prompt the tenant to enter a
 * key, rather than surfacing it as a generic 5xx.
 */
export class AiKeyMissingError extends Error {
  readonly code = 'AI_KEY_MISSING';
  constructor(message = 'No valid AI API key configured for this tenant') {
    super(message);
    this.name = 'AiKeyMissingError';
  }
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  persona: string;
  tenantId: string;
  userId: string;
  userRoles: string[];
  /**
   * Faz 7c: the caller's tenant-RBAC capabilities, used to authorize the
   * requested persona tier (`ai_personas:<tier>`) in AgentProfileService.
   */
  resourcePermissions: string[];
  schemaName: string;
  correlationId: string;
}

/**
 * Per-class token usage breakdown.
 *
 * TENANTCOST-HIGH-002 cure: Anthropic returns four distinct token
 * classes — each priced differently. Summing only input+output drops
 * the cache deltas, producing a tenant-cost figure that diverges from
 * Stripe's metering by a model-specific factor.
 *
 *   - input               — fresh prompt tokens read from the request
 *   - output              — generation tokens written by the model
 *   - cacheRead           — prompt tokens served from prompt cache
 *                           (pricing typically ~10% of input)
 *   - cacheCreation       — prompt tokens written into the cache on
 *                           first use (pricing typically ~125% of input)
 *
 * `total` is the BILLABLE token counter consumed by TokenBudgetService:
 * input + output + cacheCreation. Cache creation is included because the
 * provider bills those tokens ABOVE the input rate (~1.25x) — excluding
 * them let cached-prompt tenants consume unbounded cache writes outside
 * the monthly budget (DB-PEOPLE-MEDIUM-002). Cache READS stay excluded:
 * they bill at ~0.1x input and metering them as full tokens would punish
 * exactly the callers the prompt cache is meant to reward. The per-class
 * USD rollup lives in cost/model-pricing.ts (TurnLedgerService).
 */
export interface TokenUsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface ChatResponse {
  conversationId: string;
  message: string;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: unknown;
  }>;
  tokenUsage: TokenUsageBreakdown;
  /**
   * MOB-HIGH-001: a held actuation-class tool call, persisted as a proposal
   * awaiting human confirmation. Rides the chat response metadata so the
   * messaging bridge stores it on the AI message (status:'proposed') and the
   * clients render a confirmation card. One per turn — the first held call.
   */
  proposedAction?: {
    actionId: string;
    actionType: string;
    params: Record<string, unknown>;
    description: string;
  };
}

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);
  private readonly maxToolLoops: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly profileService: AgentProfileService,
    private readonly conversationService: ConversationService,
    private readonly tokenBudget: TokenBudgetService,
    private readonly rateLimit: RateLimitService,
    private readonly turnLedger: TurnLedgerService,
    private readonly agentConfig: AgentConfigService,
    private readonly aiSafety: AiSafetyMiddleware,
    private readonly breaker: CircuitBreakerService,
    private readonly providerFactory: LlmProviderFactory,
    private readonly actionProposals: ActionProposalService,
  ) {
    // FAZ1-BYOK: the process-global Anthropic client is gone. Each request runs
    // against the tenant's own decrypted key, resolved below and passed to the
    // provider per call — no platform key, no shared client.
    this.maxToolLoops = this.configService.get<number>('AI_MAX_TOOL_LOOPS', 10);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // 1. FAZ1-BYOK: fail-closed enablement — AI runs ONLY when the tenant switch
    // is on AND a key exists for the selected provider. Resolve the credential
    // up front so a key-less tenant is rejected before any work or cost.
    const enablement = await this.agentConfig.resolveEnablement(request.tenantId);
    if (!enablement.enabled) {
      if (enablement.reason === 'key_missing') {
        throw new AiKeyMissingError();
      }
      throw new Error('AI features are not enabled for this tenant');
    }

    const credential = await this.agentConfig.resolveCredential(request.tenantId);
    if (!credential) {
      // Enablement said ok but the key vanished between reads — treat as missing.
      throw new AiKeyMissingError();
    }
    const provider = this.providerFactory.get(credential.provider);

    // 2. Check rate limit
    const config = await this.agentConfig.getConfig(request.tenantId);
    const rateLimitCheck = await this.rateLimit.checkRateLimit(
      request.tenantId,
      config.hourlyRequestLimit,
    );
    if (!rateLimitCheck.allowed) {
      throw new Error(`Rate limit exceeded. Resets at ${rateLimitCheck.resetAt.toISOString()}`);
    }

    // 3. Token budget: enforced ATOMICALLY per provider call below
    // (SEC-MEDIUM-075 — the old read-then-spend pre-check raced; every
    // concurrent request passed it and all spent). reserveBudget is the
    // single enforcement point.

    // 4. Resolve agent profile (persona tier authorized against the caller's
    // tenant-RBAC capabilities — roles feed the admin bypass, resourcePermissions
    // the ai_personas:<tier> grant).
    const profile = await this.profileService.resolveProfile(request.tenantId, request.persona, {
      roles: request.userRoles,
      resourcePermissions: request.resourcePermissions,
    });

    // 5. Get or create conversation
    let conversationId = request.conversationId;
    if (!conversationId) {
      const conversation = await this.conversationService.create({
        tenantId: request.tenantId,
        userId: request.userId,
        persona: request.persona,
      });
      conversationId = conversation.id;
    }

    // 6. Build messages
    // SECURITY: getById now requires tenantId + userId ownership check.
    // A caller-supplied conversationId belonging to another tenant/user
    // returns null, preventing cross-tenant conversation hydration and
    // prompt-injection via foreign conversation history (CRITICAL-001).
    const existingConversation = conversationId
      ? await this.conversationService.getById(conversationId, request.tenantId, request.userId)
      : null;

    const messages: LlmMessage[] = [];

    // Add existing conversation history (stored as plain strings → text blocks)
    if (existingConversation?.messages) {
      for (const msg of existingConversation.messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({
            role: msg.role,
            content: [{ type: 'text', text: msg.content }],
          });
        }
      }
    }

    // Add new user message
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: request.message }],
    });

    // Save user message to conversation
    // SECURITY: addMessage now requires tenantId + userId ownership check
    await this.conversationService.addMessage(conversationId, request.tenantId, request.userId, {
      role: 'user',
      content: request.message,
      timestamp: new Date().toISOString(),
    });

    // 7. SECURITY: Pre-process input through AI safety pipeline (jailbreak filter + prompt hardening)
    const safetyResult = this.aiSafety.preProcess(
      request.message,
      request.tenantId,
      profile.persona.name,
      profile.persona.systemPrompt,
    );

    if (!safetyResult.allowed) {
      this.logger.warn(
        `AI safety rejected input for tenant ${request.tenantId}: ${safetyResult.rejectionReason}`,
      );
      throw new Error('Your message was flagged by our safety system and cannot be processed.');
    }

    // Use hardened system prompt if instruction hierarchy is active
    const effectiveSystemPrompt =
      safetyResult.hardenedSystemPrompt ?? profile.effectiveSystemPrompt;

    // 8. Build tool definitions (provider-neutral shape)
    const toolDefinitions: LlmToolDefinition[] = this.toolRegistry
      .getClaudeToolDefinitions(profile.effectiveToolNames)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
      }));

    // 9. Run agent loop
    const toolCalls: ChatResponse['toolCalls'] = [];
    // MOB-HIGH-001: the first held actuation of the turn becomes a persisted
    // proposal + confirmation card. One per turn — chat metadata carries a
    // single card, and one confirmable side effect per exchange is the safe UX.
    let proposedAction: ChatResponse['proposedAction'];
    const totalTokens: TokenUsageBreakdown = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
    };
    let finalMessage = '';

    const toolContext: ToolExecutionContext = {
      tenantId: request.tenantId,
      schemaName: request.schemaName,
      userId: request.userId,
      userRoles: request.userRoles,
      correlationId: request.correlationId,
      persona: request.persona,
      // AISAFETY-MEDIUM-017: the resolved actuation policy (persona ∧ tenant,
      // most-restrictive) gates whether an actuation tool may run autonomously.
      actuationPolicy: profile.actuationPolicy,
    };

    const currentMessages = [...messages];
    let loopCount = 0;

    while (loopCount < this.maxToolLoops) {
      loopCount++;

      // CIRCUIT-CRITICAL-001 cure: every provider API call rides through the
      // canonical sliding-window breaker, scoped per (provider, tenantId).
      // fail-CLOSED is mandatory for billable upstreams — a degraded response
      // must NOT silently substitute a free fallback the user thinks is real.
      // Per-tenant + per-provider key isolates noisy-neighbor: one tenant's
      // runaway loop cannot trip the breaker for everyone, and one provider's
      // outage does not trip the other.
      let response;
      // SEC-MEDIUM-075: reserve the per-call ceiling BEFORE the billable
      // call; settle to actual usage right after. Concurrent requests can no
      // longer all pass one shared pre-check.
      await this.tokenBudget.reserveBudget(
        request.tenantId,
        config.monthlyTokenBudget,
        profile.persona.maxTokensPerTurn,
      );
      try {
        response = await this.breaker.execute({
          serviceName: `${credential.provider}-api`,
          tenantId: request.tenantId,
          options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
          fn: () =>
            provider.chat(
              {
                model: profile.persona.model,
                maxTokens: profile.persona.maxTokensPerTurn,
                system: effectiveSystemPrompt,
                tools: toolDefinitions,
                messages: currentMessages,
              },
              credential,
            ),
        });
      } catch (err) {
        // The call never produced billable tokens — refund the reservation
        // (budget-exceeded errors already rolled their reservation back).
        if (!(err instanceof Error && err.message.includes('token budget'))) {
          await this.tokenBudget.settleReservation(
            request.tenantId,
            profile.persona.maxTokensPerTurn,
            0,
          );
        }
        // A rejected key is a tenant-actionable configuration problem, not a
        // transient outage — surface it as AI_KEY_MISSING so the UI prompts for
        // a new key instead of showing a generic failure.
        if (err instanceof LlmAuthError) {
          throw new AiKeyMissingError('The configured AI API key was rejected');
        }
        throw err;
      }

      // Track every token class (providers report cache_* as 0 when absent, so
      // the rollup gets explicit zeros instead of NaN).
      totalTokens.input += response.usage.input;
      totalTokens.output += response.usage.output;
      totalTokens.cacheRead += response.usage.cacheRead;
      totalTokens.cacheCreation += response.usage.cacheCreation;
      // DB-PEOPLE-MEDIUM-002 cure: `total` (the TokenBudgetService counter)
      // now includes cacheCreation — those tokens bill ABOVE the input rate
      // (~1.25x), so leaving them out let cached-prompt turns consume
      // unbounded cache writes outside the monthly budget. Cache READS stay
      // excluded (billed at ~0.1x input; see TokenUsageBreakdown docblock).
      totalTokens.total +=
        response.usage.input + response.usage.output + response.usage.cacheCreation;

      // SEC-MEDIUM-075: refund the unused part of this call's reservation.
      await this.tokenBudget.settleReservation(
        request.tenantId,
        profile.persona.maxTokensPerTurn,
        response.usage.input + response.usage.output + response.usage.cacheCreation,
      );

      // Process response content
      const textBlocks: string[] = [];
      const toolUseBlocks: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      // If no tool use, we're done
      if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
        finalMessage = textBlocks.join('\n');
        break;
      }

      // Execute tools and build tool results.
      // Add assistant message with the model's produced blocks (text + tool_use).
      currentMessages.push({ role: 'assistant', content: response.content });

      const toolResults: LlmContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        // SECURITY: Validate tool call through safety pipeline before execution.
        const toolMeta = this.toolRegistry.getClaudeToolDefinitions([toolUse.name]);
        const toolSchema: Record<string, unknown> = toolMeta[0]?.input_schema ?? {};
        const urls = Object.values(toolUse.input).filter(
          (v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v),
        );

        const toolValidation = await this.aiSafety.validateToolCall(
          toolUse.name,
          toolUse.input,
          toolSchema,
          urls.length > 0 ? urls : undefined,
        );

        if (!toolValidation.allowed) {
          this.logger.warn(
            `AI safety blocked tool call ${toolUse.name}: ${toolValidation.rejectionReason}`,
          );
          toolResults.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: `Error: Tool call blocked by safety validation: ${toolValidation.rejectionReason}`,
            isError: true,
          });
          continue;
        }

        const result = await this.toolExecutor.executeTool(
          toolUse.name,
          toolUse.input,
          toolContext,
        );

        // MOB-HIGH-001: a held actuation (confirm_required policy) is not an
        // error — it becomes a PERSISTED proposal whose id rides the response
        // metadata as a confirmation card. The stored row (tool + params +
        // requester context) is what executes on confirm; the model is told to
        // direct the user to the card instead of retrying the tool.
        if (!result.success && result.requiresConfirmation && !proposedAction) {
          const proposal = await this.actionProposals.createProposal({
            tenantId: request.tenantId,
            toolName: toolUse.name,
            params: toolUse.input,
            description: this.describeAction(toolUse.name, toolUse.input),
            requestedBy: request.userId,
            requesterRoles: request.userRoles,
            persona: request.persona,
            correlationId: request.correlationId,
          });
          proposedAction = {
            actionId: proposal.id,
            actionType: proposal.toolName,
            params: proposal.params,
            description: proposal.description,
          };
          toolCalls.push({
            name: toolUse.name,
            input: toolUse.input,
            result: { heldForConfirmation: true, actionId: proposal.id },
          });
          toolResults.push({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content:
              'The action was HELD for human confirmation and a confirmation card was ' +
              'shown to the user. Do not retry the tool — tell the user to review and ' +
              'confirm the card to execute it.',
            isError: false,
          });
          continue;
        }

        toolCalls.push({
          name: toolUse.name,
          input: toolUse.input,
          result: result.data,
        });

        toolResults.push({
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: result.success ? JSON.stringify(result.data) : `Error: ${result.error}`,
          isError: !result.success,
        });
      }

      currentMessages.push({ role: 'user', content: toolResults });

      // If the text portion had content, capture it
      if (textBlocks.length > 0) {
        finalMessage = textBlocks.join('\n');
      }
    }

    // 10. SECURITY: Post-process model output through AI safety pipeline (PII redaction)
    const postResult = this.aiSafety.postProcess(finalMessage, request.tenantId);
    finalMessage = postResult.outputText;

    if (postResult.piiRedacted) {
      this.logger.warn(`AI safety redacted PII from output for tenant ${request.tenantId}`);
    }

    // 11. Durable per-turn cost ledger (ORPHAN-MEDIUM-380): append one
    // immutable conversation_turns row for this completed invocation.
    // Placed BEFORE the mutable conversation/budget writes so the finance
    // and safety-forensics record survives a downstream write failure — the
    // provider has already billed these tokens either way. The write is
    // awaited (no floating promise) but never throws: TurnLedgerService
    // catches, logs loudly, and returns false so a ledger outage cannot
    // break the chat path. Redis (step 13) remains the fast enforcement
    // cache; this row is the durable SSoT.
    const flaggedCategories: string[] = [
      ...(safetyResult.inputFilter?.flaggedPatterns ?? []).map((pattern) => `input:${pattern}`),
      ...(postResult.piiRedacted ? ['output:pii_redacted'] : []),
    ];
    await this.turnLedger.recordTurn({
      tenantId: request.tenantId,
      conversationId,
      personaId: request.persona,
      model: profile.persona.model,
      usage: {
        input: totalTokens.input,
        output: totalTokens.output,
        cacheRead: totalTokens.cacheRead,
        cacheCreation: totalTokens.cacheCreation,
      },
      flaggedCategories,
    });

    // 12. Save assistant response to conversation
    // SECURITY: addMessage requires tenantId + userId ownership check
    await this.conversationService.addMessage(conversationId, request.tenantId, request.userId, {
      role: 'assistant',
      content: finalMessage,
      toolUse: toolCalls,
      timestamp: new Date().toISOString(),
    });

    // 13. Update token usage (total = input + output + cacheCreation — see
    // the TokenUsageBreakdown docblock for the budget semantics)
    // SEC-MEDIUM-075: budget accounting happened per call via
    // reserve/settle — a final addUsage here would double-count.
    await this.conversationService.updateTokenCount(
      conversationId,
      request.tenantId,
      request.userId,
      totalTokens.total,
    );

    return {
      conversationId,
      message: finalMessage,
      toolCalls,
      tokenUsage: totalTokens,
      proposedAction,
    };
  }

  /**
   * Human-readable one-liner for the confirmation card. Uses the input's
   * title/name when present so the user confirms WHAT, not just WHICH tool.
   */
  private describeAction(toolName: string, input: Record<string, unknown>): string {
    const title = input['title'] ?? input['name'];
    if (typeof title === 'string' && title.trim().length > 0) {
      return `${toolName}: "${title.trim()}"`;
    }
    return `Run ${toolName}`;
  }
}
