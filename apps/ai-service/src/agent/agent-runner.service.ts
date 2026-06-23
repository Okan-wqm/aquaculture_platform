import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
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
  private readonly anthropic: Anthropic;
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
  ) {
    this.anthropic = new Anthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY'),
    });
    this.maxToolLoops = this.configService.get<number>(
      'AI_MAX_TOOL_LOOPS',
      10,
    );
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // 1. Check if AI is enabled for tenant
    const isEnabled = await this.agentConfig.isEnabled(request.tenantId);
    if (!isEnabled) {
      throw new Error('AI features are not enabled for this tenant');
    }

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

    const messages: Anthropic.MessageParam[] = [];

    // Add existing conversation history
    if (existingConversation?.messages) {
      for (const msg of existingConversation.messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // Add new user message
    messages.push({ role: 'user', content: request.message });

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

    // 8. Build tool definitions
    const toolDefinitions = this.toolRegistry.getClaudeToolDefinitions(
      profile.effectiveToolNames,
    );

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

      // CIRCUIT-CRITICAL-001 cure: every Anthropic API call rides through
      // the canonical sliding-window breaker, scoped per (serviceName,
      // tenantId). fail-CLOSED is mandatory for billable upstreams — a
      // degraded response from the AI must NOT silently substitute a free
      // fallback that the user thinks is the real answer. Per-tenant key
      // isolates noisy-neighbor: one tenant's runaway agent loop cannot
      // trip the breaker for everyone.
      const response = await this.breaker.execute({
        serviceName: 'anthropic-api',
        tenantId: request.tenantId,
        options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
        fn: () =>
          this.anthropic.messages.create({
            model: profile.persona.model,
            max_tokens: profile.persona.maxTokensPerTurn,
            system: effectiveSystemPrompt,
            tools: toolDefinitions as Anthropic.Tool[],
            messages: currentMessages,
          }),
      });

      // TENANTCOST-HIGH-002 cure: track every Anthropic token class.
      // The Anthropic SDK types these as optional (older API versions
      // didn't surface cache_*); coalesce to 0 so downstream rollup
      // gets explicit zeros instead of NaN.
      totalTokens.input += response.usage.input_tokens;
      totalTokens.output += response.usage.output_tokens;
      const cacheRead =
        (response.usage as { cache_read_input_tokens?: number })
          .cache_read_input_tokens ?? 0;
      const cacheCreation =
        (response.usage as { cache_creation_input_tokens?: number })
          .cache_creation_input_tokens ?? 0;
      totalTokens.cacheRead += cacheRead;
      totalTokens.cacheCreation += cacheCreation;
      // `total` keeps the legacy semantics (input + output sum) because
      // downstream TokenBudgetService consumes it as a single counter.
      // Cost-weighted accounting that uses the per-class breakdown
      // happens in the W4 cost-rollup pipeline, NOT here.
      totalTokens.total +=
        response.usage.input_tokens + response.usage.output_tokens;

      // Process response content
      const textBlocks: string[] = [];
      const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      // If no tool use, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        finalMessage = textBlocks.join('\n');
        break;
      }

      // Execute tools and build tool results
      // Add assistant message with tool_use blocks
      currentMessages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        // SECURITY: Validate tool call through safety pipeline before execution.
        const toolMeta = this.toolRegistry.getClaudeToolDefinitions([toolUse.name]);
        const toolSchema: Record<string, unknown> =
          toolMeta[0]?.input_schema ?? {};
        const inputRecord = toolUse.input as Record<string, unknown>;
        const urls = Object.values(inputRecord).filter(
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
            tool_use_id: toolUse.id,
            content: `Error: Tool call blocked by safety validation: ${toolValidation.rejectionReason}`,
            is_error: true,
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
          input: toolUse.input as Record<string, unknown>,
          result: result.data,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.success
            ? JSON.stringify(result.data)
            : `Error: ${result.error}`,
          is_error: !result.success,
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
