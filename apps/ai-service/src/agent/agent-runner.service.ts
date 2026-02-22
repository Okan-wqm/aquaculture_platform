import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ToolExecutorService } from '../tools/core/tool-executor.service';
import { AgentProfileService, ResolvedProfile } from './agent-profile.service';
import { ConversationService } from '../conversation/conversation.service';
import { TokenBudgetService } from '../cost/token-budget.service';
import { RateLimitService } from '../cost/rate-limit.service';
import { AgentConfigService } from '../tenant-config/agent-config.service';
import { ToolExecutionContext } from '../tools/core/tool.interface';

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

export interface ChatResponse {
  conversationId: string;
  message: string;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: unknown;
  }>;
  tokenUsage: { input: number; output: number; total: number };
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
    const existingConversation = conversationId
      ? await this.conversationService.getById(conversationId)
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
    await this.conversationService.addMessage(conversationId, {
      role: 'user',
      content: request.message,
      timestamp: new Date().toISOString(),
    });

    // 7. Build tool definitions
    const toolDefinitions = this.toolRegistry.getClaudeToolDefinitions(
      profile.effectiveToolNames,
    );

    // 8. Run agent loop
    const toolCalls: ChatResponse['toolCalls'] = [];
    const totalTokens = { input: 0, output: 0, total: 0 };
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

      const response = await this.anthropic.messages.create({
        model: profile.persona.model,
        max_tokens: profile.persona.maxTokensPerTurn,
        system: profile.effectiveSystemPrompt,
        tools: toolDefinitions as Anthropic.Tool[],
        messages: currentMessages,
      });

      // Track token usage
      totalTokens.input += response.usage.input_tokens;
      totalTokens.output += response.usage.output_tokens;
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

    // 9. Save assistant response to conversation
    await this.conversationService.addMessage(conversationId, {
      role: 'assistant',
      content: finalMessage,
      toolUse: toolCalls,
      timestamp: new Date().toISOString(),
    });

    // 10. Update token usage
    await this.tokenBudget.addUsage(request.tenantId, totalTokens.total);
    await this.conversationService.updateTokenCount(
      conversationId,
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
