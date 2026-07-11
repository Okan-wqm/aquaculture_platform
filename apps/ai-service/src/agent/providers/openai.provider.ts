import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  LlmAuthError,
  LlmChatParams,
  LlmChatResult,
  LlmContentBlock,
  LlmCredential,
  LlmProvider,
  LlmResultBlock,
  LlmStopReason,
} from './llm-provider.interface';

/**
 * OpenAI implementation of the provider-neutral LlmProvider contract (Faz 1b).
 *
 * The agent loop speaks the Anthropic-shaped normalized contract (a message is
 * a list of text / tool_use / tool_result blocks). OpenAI's Chat Completions
 * model is different — an assistant turn carries `tool_calls`, and each tool
 * result is its OWN `role: 'tool'` message keyed by tool_call_id. This provider
 * is the sole place that translation lives; nothing leaks into the loop.
 *
 * Client cache + eviction mirror AnthropicProvider (keyed by SHA-256 of the key,
 * never the plaintext; hard-capped so key churn cannot grow the map unbounded).
 */
const MAX_CACHED_CLIENTS = 256;

@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly clients = new Map<string, OpenAI>();

  private clientFor(apiKey: string): OpenAI {
    const cacheKey = createHash('sha256').update(apiKey).digest('hex');
    const cached = this.clients.get(cacheKey);
    if (cached) {
      this.clients.delete(cacheKey);
      this.clients.set(cacheKey, cached);
      return cached;
    }

    if (this.clients.size >= MAX_CACHED_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) {
        this.clients.delete(oldest);
      }
    }

    const client = new OpenAI({ apiKey });
    this.clients.set(cacheKey, client);
    return client;
  }

  async chat(
    params: LlmChatParams,
    credential: LlmCredential,
  ): Promise<LlmChatResult> {
    const client = this.clientFor(credential.apiKey);

    const tools: ChatCompletionTool[] = params.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: params.model,
        max_completion_tokens: params.maxTokens,
        messages: this.toOpenAiMessages(params.system, params.messages),
        // Only pass `tools` when non-empty — the API rejects an empty array.
        ...(tools.length > 0 ? { tools } : {}),
      });
    } catch (err) {
      if (
        err instanceof OpenAI.AuthenticationError ||
        err instanceof OpenAI.PermissionDeniedError
      ) {
        this.logger.warn('OpenAI rejected the tenant credential (auth/permission)');
        throw new LlmAuthError('openai', 'OpenAI credential was rejected');
      }
      throw err;
    }

    const choice = response.choices[0];
    const message = choice?.message;
    const content: LlmResultBlock[] = [];
    if (message?.content) {
      content.push({ type: 'text', text: message.content });
    }
    for (const call of message?.tool_calls ?? []) {
      // Only function tool calls are issued (we advertise function tools only).
      if (call.type !== 'function') continue;
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: this.parseToolArguments(call.function.arguments),
      });
    }

    const usage = response.usage;
    return {
      content,
      usage: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        // OpenAI surfaces cached prompt tokens; it has no cache-CREATION class,
        // so that stays 0 (explicit zero, never NaN — the cost rollup needs it).
        cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheCreation: 0,
      },
      stopReason: this.mapStopReason(choice?.finish_reason),
    };
  }

  async validateCredential(credential: LlmCredential): Promise<boolean> {
    const client = this.clientFor(credential.apiKey);
    try {
      // models.list is a pure authorization probe: it needs no model access or
      // billing, so it distinguishes "bad key" (401) from "valid key, no access
      // to a given model" cleanly — unlike a chat completion.
      await client.models.list();
      return true;
    } catch (err) {
      if (err instanceof OpenAI.AuthenticationError) {
        return false;
      }
      // 403 = the key authenticated but the org restricts this endpoint; the key
      // itself is valid, so accept it (a real access problem surfaces at chat
      // time). Transient failures (429/5xx/network) are not a key verdict.
      if (err instanceof OpenAI.PermissionDeniedError) {
        this.logger.warn(
          'OpenAI key authenticated but models.list is restricted (permission) — accepting the key as valid',
        );
        return true;
      }
      throw err;
    }
  }

  /**
   * Flatten the normalized message list into OpenAI's shape. tool_result blocks
   * become standalone `role: 'tool'` messages (OpenAI requires them keyed by
   * tool_call_id and following the assistant turn that issued the call); text
   * and tool_use collapse into a single assistant/user message per turn.
   */
  private toOpenAiMessages(
    system: string,
    messages: LlmChatParams['messages'],
  ): ChatCompletionMessageParam[] {
    const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];

    for (const message of messages) {
      if (message.role === 'assistant') {
        out.push(this.toAssistantMessage(message.content));
        continue;
      }
      // user turn: tool_result blocks are separate `tool` messages; the rest is
      // the user's text.
      const text: string[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: block.content,
          });
        } else if (block.type === 'text') {
          text.push(block.text);
        }
      }
      if (text.length > 0) {
        out.push({ role: 'user', content: text.join('\n') });
      }
    }

    return out;
  }

  private toAssistantMessage(
    blocks: LlmContentBlock[],
  ): ChatCompletionMessageParam {
    const text: string[] = [];
    const toolCalls: NonNullable<
      Extract<ChatCompletionMessageParam, { role: 'assistant' }>['tool_calls']
    > = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        text.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }
    return {
      role: 'assistant',
      content: text.length > 0 ? text.join('\n') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  private parseToolArguments(raw: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      // A malformed arguments string is an upstream anomaly, not a crash — hand
      // the tool an empty object so the loop can proceed / the tool can reject.
      this.logger.warn('OpenAI returned unparseable tool-call arguments');
      return {};
    }
  }

  private mapStopReason(
    reason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] | undefined,
  ): LlmStopReason {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
      case 'function_call':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      default:
        return 'other';
    }
  }
}
