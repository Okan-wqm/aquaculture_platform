import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ToolExecutorService } from '../tools/core/tool-executor.service';
import { AgentProfileService } from './agent-profile.service';
import { ConversationService } from '../conversation/conversation.service';
import { TokenBudgetService } from '../cost/token-budget.service';
import { RateLimitService } from '../cost/rate-limit.service';
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
 * `total` is the cost-weighted-equivalent count for back-compat
 * downstream consumers; the per-class fields drive the cost rollup
 * with the model-specific multiplier from cost_catalog.
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
    private readonly agentConfig: AgentConfigService,
    private readonly aiSafety: AiSafetyMiddleware,
    private readonly breaker: CircuitBreakerService,
    private readonly providerFactory: LlmProviderFactory,
  ) {
    // FAZ1-BYOK: the process-global Anthropic client is gone. Each request runs
    // against the tenant's own decrypted key, resolved below and passed to the
    // provider per call — no platform key, no shared client.
    this.maxToolLoops = this.configService.get<number>(
      'AI_MAX_TOOL_LOOPS',
      10,
    );
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
      throw new Error(
        `Rate limit exceeded. Resets at ${rateLimitCheck.resetAt.toISOString()}`,
      );
    }

    // 3. Check token budget
    const budgetCheck = await this.tokenBudget.checkBudget(
      request.tenantId,
      config.monthlyTokenBudget,
    );
    if (!budgetCheck.allowed) {
      throw new Error(
        `Monthly token budget exceeded (${budgetCheck.used}/${config.monthlyTokenBudget})`,
      );
    }

    // 4. Resolve agent profile
    const profile = await this.profileService.resolveProfile(
      request.tenantId,
      request.persona,
    );

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
      ? await this.conversationService.getById(
          conversationId,
          request.tenantId,
          request.userId,
        )
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
    await this.conversationService.addMessage(
      conversationId,
      request.tenantId,
      request.userId,
      {
        role: 'user',
        content: request.message,
        timestamp: new Date().toISOString(),
      },
    );

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
      throw new Error(
        'Your message was flagged by our safety system and cannot be processed.',
      );
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
      // `total` keeps the legacy semantics (input + output sum) because
      // downstream TokenBudgetService consumes it as a single counter.
      totalTokens.total += response.usage.input + response.usage.output;

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
        const toolSchema: Record<string, unknown> =
          toolMeta[0]?.input_schema ?? {};
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

        toolCalls.push({
          name: toolUse.name,
          input: toolUse.input,
          result: result.data,
        });

        toolResults.push({
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: result.success
            ? JSON.stringify(result.data)
            : `Error: ${result.error}`,
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
      this.logger.warn(
        `AI safety redacted PII from output for tenant ${request.tenantId}`,
      );
    }

    // 11. Save assistant response to conversation
    // SECURITY: addMessage requires tenantId + userId ownership check
    await this.conversationService.addMessage(
      conversationId,
      request.tenantId,
      request.userId,
      {
        role: 'assistant',
        content: finalMessage,
        toolUse: toolCalls,
        timestamp: new Date().toISOString(),
      },
    );

    // 12. Update token usage
    await this.tokenBudget.addUsage(request.tenantId, totalTokens.total);
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
    };
  }
}
