/**
 * FARM-AI-0.1: provider transport timeouts are load-bearing.
 *
 * The OpenAI SDK defaults to 600s timeout + 2 retries; a single hung
 * Z.ai/OpenAI/Anthropic call could block a cron cadence or watch scan for
 * 10+ minutes. These specs pin the 30s / 1-retry contract through each
 * provider's protected client factory (a probe subclass — no cast).
 */
import 'reflect-metadata';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';

import { AnthropicProvider } from '../anthropic.provider';
import type { LlmChatParams } from '../llm-provider.interface';
import { OpenAiProvider } from '../openai.provider';
import { ZaiProvider } from '../zai.provider';

class ProbeOpenAi extends OpenAiProvider {
  client(apiKey: string): OpenAI {
    return this.newClient(apiKey);
  }
}
class ProbeZai extends ZaiProvider {
  client(apiKey: string): OpenAI {
    return this.newClient(apiKey);
  }
}
class ProbeAnthropic extends AnthropicProvider {
  client(apiKey: string): Anthropic {
    return this.newClient(apiKey);
  }
}

describe('Provider transport timeout (FARM-AI-0.1)', () => {
  it('OpenAI client carries timeout=30s and maxRetries=1', () => {
    const client = new ProbeOpenAi().client('sk-test-key');
    expect(client.timeout).toBe(30_000);
    expect(client.maxRetries).toBe(1);
  });

  it('ZaiProvider keeps the same transport contract through its newClient override', () => {
    const client = new ProbeZai().client('sk-zai-test');
    expect(client.timeout).toBe(30_000);
    expect(client.maxRetries).toBe(1);
  });

  it('Anthropic client carries timeout=30s and maxRetries=1', () => {
    const client = new ProbeAnthropic().client('sk-ant-test');
    expect(client.timeout).toBe(30_000);
    expect(client.maxRetries).toBe(1);
  });

  it('LlmChatParams accepts an optional AbortSignal', () => {
    const controller = new AbortController();
    const params: Pick<LlmChatParams, 'signal'> = { signal: controller.signal };
    expect(params.signal?.aborted).toBe(false);
  });
});
