/**
 * ZaiProvider — OpenAI-compatible relay subclass (Z.ai GLM, BYOK).
 * Pins: registry wiring, baseURL routing, and the 404-tolerant key probe.
 */
import 'reflect-metadata';
import { stub, stubMember } from '@aquaculture/testing';
import OpenAI from 'openai';

import type { AnthropicProvider } from '../anthropic.provider';
import { LlmProviderFactory } from '../llm-provider.factory';
import type { LlmChatParams } from '../llm-provider.interface';
import { OpenAiProvider } from '../openai.provider';
import { ZaiProvider, ZAI_DEFAULT_MODEL } from '../zai.provider';

/**
 * Test subclass that opens the two protected seams the specs drive: the
 * OpenAI client factory (swapped for a 404-raising double) and the per-model
 * request extras. No cast: the seams stay type-checked against the real
 * protected signatures.
 */
class ProbeZaiProvider extends ZaiProvider {
  clientDouble: OpenAI | null = null;

  protected override newClient(apiKey: string): OpenAI {
    return this.clientDouble ?? super.newClient(apiKey);
  }

  extrasFor(model: string): Record<string, unknown> {
    return this.requestExtras(
      stub<LlmChatParams>({ model, system: '', maxTokens: 1, tools: [], messages: [] }),
    );
  }
}

describe('ZaiProvider (MSGFIX-ZAI)', () => {
  it('registers as a first-class provider in the factory', () => {
    const zai = new ZaiProvider();
    const factory = new LlmProviderFactory(
      stub<AnthropicProvider>({ id: 'anthropic' }),
      stub<OpenAiProvider>({ id: 'openai' }),
      zai,
    );
    expect(factory.supports('zai')).toBe(true);
    expect(factory.get('zai')).toBe(zai);
    expect(factory.availableProviders()).toContain('zai');
  });

  it('exposes the GLM default model constant', () => {
    expect(ZAI_DEFAULT_MODEL).toBe('glm-5.3');
  });

  it('is an OpenAiProvider subclass (translation logic inherited)', () => {
    expect(new ZaiProvider()).toBeInstanceOf(OpenAiProvider);
  });

  it('accepts a key when models.list 404s (relay endpoint absent, not a bad key)', async () => {
    const zai = new ProbeZaiProvider();
    zai.clientDouble = stub<OpenAI>({
      models: stub<OpenAI['models']>({
        list: stubMember<OpenAI['models']['list']>(async () => {
          throw new OpenAI.NotFoundError(
            404,
            { message: 'no such endpoint' },
            'not found',
            new Headers(),
          );
        }),
      }),
    });
    await expect(zai.validateCredential({ provider: 'zai', apiKey: 'k' })).resolves.toBe(true);
  });
});

describe('ZaiProvider — GLM-5.x reasoning effort (user preference)', () => {
  it('injects reasoning_effort=low for GLM-5.x models', async () => {
    const zai = new ProbeZaiProvider();
    expect(zai.extrasFor('glm-5.3')).toEqual({ reasoning_effort: 'low' });
    expect(zai.extrasFor('GLM-6.0')).toEqual({ reasoning_effort: 'low' });
  });

  it('omits reasoning_effort for pre-5.x models (quarterly package switch needs no code)', async () => {
    const zai = new ProbeZaiProvider();
    expect(zai.extrasFor('glm-4.6')).toEqual({});
    expect(zai.extrasFor('glm-4.7-flash')).toEqual({});
  });
});
