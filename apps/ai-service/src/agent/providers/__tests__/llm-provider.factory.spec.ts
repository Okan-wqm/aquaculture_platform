import 'reflect-metadata';
import { AnthropicProvider } from '../anthropic.provider';
import { LlmProviderFactory } from '../llm-provider.factory';
import type { LlmProviderId } from '../llm-provider.interface';
import { OpenAiProvider } from '../openai.provider';
import { ZaiProvider } from '../zai.provider';

describe('LlmProviderFactory', () => {
  const anthropic = { id: 'anthropic' } as AnthropicProvider;
  const openai = { id: 'openai' } as OpenAiProvider;
  const zai = { id: 'zai' } as ZaiProvider;
  const factory = new LlmProviderFactory(anthropic, openai, zai);

  it('resolves every wired provider by its id', () => {
    expect(factory.get('anthropic')).toBe(anthropic);
    expect(factory.get('openai')).toBe(openai);
    expect(factory.get('zai')).toBe(zai);
    expect(factory.supports('anthropic')).toBe(true);
    expect(factory.supports('openai')).toBe(true);
    expect(factory.supports('zai')).toBe(true);
    expect(factory.availableProviders()).toEqual(['anthropic', 'openai', 'zai']);
  });

  it('fails fast for an unknown provider rather than defaulting to another', () => {
    // A provider id outside the registry (e.g. one added to the union before it
    // is wired) must be told, not silently served by an installed provider that
    // would spend the wrong key.
    const unknown = 'gemini' as LlmProviderId;
    expect(factory.supports(unknown)).toBe(false);
    expect(() => factory.get(unknown)).toThrow(/not available/i);
  });
});
