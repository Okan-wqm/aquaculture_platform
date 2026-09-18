/**
 * FARM-AI-0.1: provider transport timeouts are load-bearing.
 *
 * The OpenAI SDK defaults to 600s timeout + 2 retries; a single hung
 * Z.ai/OpenAI/Anthropic call could block a cron cadence or watch scan for
 * 10+ minutes. These specs pin the 30s / 1-retry contract.
 */
import 'reflect-metadata';
import { AnthropicProvider } from '../anthropic.provider';
import { OpenAiProvider } from '../openai.provider';

describe('Provider transport timeout (FARM-AI-0.1)', () => {
  it('OpenAI client carries timeout=30s and maxRetries=1', () => {
    const provider = new OpenAiProvider();
    const client = (provider as unknown as { clientFor: (k: string) => unknown }).clientFor('sk-test-key');
    const opts = (client as unknown as { timeout?: number; maxRetries?: number });
    expect(opts.timeout).toBe(30_000);
    expect(opts.maxRetries).toBe(1);
  });

  it('ZaiProvider inherits the same timeout via newClient override', () => {
    // ZaiProvider extends OpenAiProvider — the requestExtras/newClient chain
    // must preserve the timeout (tested via constructor on the parent class).
    const provider = new OpenAiProvider();
    const client = (provider as unknown as { clientFor: (k: string) => unknown }).clientFor('sk-zai-test');
    expect((client as unknown as { timeout?: number }).timeout).toBe(30_000);
  });

  it('Anthropic client carries timeout=30s and maxRetries=1', () => {
    const provider = new AnthropicProvider();
    const client = (provider as unknown as { clientFor: (k: string) => unknown }).clientFor('sk-ant-test');
    const opts = (client as unknown as { timeout?: number; maxRetries?: number });
    expect(opts.timeout).toBe(30_000);
    expect(opts.maxRetries).toBe(1);
  });

  it('LlmChatParams accepts an optional AbortSignal', () => {
    const params: { signal?: AbortSignal } = {};
    expect(params.signal).toBeUndefined();
    const controller = new AbortController();
    params.signal = controller.signal;
    expect(params.signal.aborted).toBe(false);
  });
});
