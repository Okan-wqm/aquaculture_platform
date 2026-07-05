import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
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
 * Bounded client cache. Building an `Anthropic` client per request is wasteful;
 * caching one per distinct key lets the SDK reuse its keep-alive agent. Keyed by
 * a SHA-256 of the key (never the plaintext) and hard-capped so a tenant churn
 * of keys cannot grow the map without bound (memory-leak discipline).
 */
const MAX_CACHED_CLIENTS = 256;

@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly clients = new Map<string, Anthropic>();

  private clientFor(apiKey: string): Anthropic {
    const cacheKey = createHash('sha256').update(apiKey).digest('hex');
    const cached = this.clients.get(cacheKey);
    if (cached) {
      // LRU touch: re-insert to mark most-recently-used.
      this.clients.delete(cacheKey);
      this.clients.set(cacheKey, cached);
      return cached;
    }

    if (this.clients.size >= MAX_CACHED_CLIENTS) {
      // Evict the oldest (first) entry — Map preserves insertion order.
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) {
        this.clients.delete(oldest);
      }
    }

    const client = new Anthropic({ apiKey });
    this.clients.set(cacheKey, client);
    return client;
  }

  async chat(
    params: LlmChatParams,
    credential: LlmCredential,
  ): Promise<LlmChatResult> {
    const client = this.clientFor(credential.apiKey);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        tools: params.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages: params.messages.map((m) => ({
          role: m.role,
          content: this.toAnthropicContent(m.content),
        })),
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        // Do NOT log the key or the SDK message verbatim (may echo request
        // detail) — a stable opaque signal is enough for the caller to map to
        // the invalid-key contract.
        this.logger.warn('Anthropic rejected the tenant credential (auth/permission)');
        throw new LlmAuthError('anthropic', 'Anthropic credential was rejected');
      }
      throw err;
    }

    const content: LlmResultBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    return {
      content,
      usage: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: this.mapStopReason(response.stop_reason),
    };
  }

  async validateCredential(credential: LlmCredential): Promise<boolean> {
    const client = this.clientFor(credential.apiKey);
    try {
      // Minimal 1-token liveness probe. A rejected key surfaces as an auth
      // error → false; any content response proves the key authenticates.
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return true;
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return false;
      }
      // A transient upstream failure (429/5xx/network) is NOT a key verdict —
      // propagate so the caller can distinguish "key is bad" from "provider is
      // down" and avoid falsely telling a tenant their valid key is invalid.
      throw err;
    }
  }

  private toAnthropicContent(
    blocks: LlmContentBlock[],
  ): Anthropic.MessageParam['content'] {
    return blocks.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'tool_use':
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
      }
    });
  }

  private mapStopReason(reason: Anthropic.Message['stop_reason']): LlmStopReason {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      default:
        return 'other';
    }
  }
}
