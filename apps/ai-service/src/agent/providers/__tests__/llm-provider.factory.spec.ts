import 'reflect-metadata';
import { AnthropicProvider } from '../anthropic.provider';
import { LlmProviderFactory } from '../llm-provider.factory';

describe('LlmProviderFactory', () => {
  const anthropic = { id: 'anthropic' } as AnthropicProvider;
  const factory = new LlmProviderFactory(anthropic);

  it('resolves the anthropic provider', () => {
    expect(factory.get('anthropic')).toBe(anthropic);
    expect(factory.supports('anthropic')).toBe(true);
    expect(factory.availableProviders()).toEqual(['anthropic']);
  });

  it('fails fast for an unwired provider rather than defaulting to another', () => {
    // openai joins the map in Faz 1b — until then it is explicitly unavailable,
    // so a tenant who selected it is told, not silently served by anthropic.
    expect(factory.supports('openai')).toBe(false);
    expect(() => factory.get('openai')).toThrow(/not available/i);
  });
});
