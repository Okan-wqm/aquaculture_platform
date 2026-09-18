/**
 * ZaiProvider — OpenAI-compatible relay subclass (Z.ai GLM, BYOK).
 * Pins: registry wiring, baseURL routing, and the 404-tolerant key probe.
 */
import 'reflect-metadata';
import OpenAI from 'openai';

import { LlmProviderFactory } from '../llm-provider.factory';
import { OpenAiProvider } from '../openai.provider';
import { ZaiProvider, ZAI_DEFAULT_MODEL } from '../zai.provider';

describe('ZaiProvider (MSGFIX-ZAI)', () => {
  it('registers as a first-class provider in the factory', () => {
    const zai = new ZaiProvider();
    const factory = new LlmProviderFactory(
      { id: 'anthropic' } as never,
      { id: 'openai' } as never,
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
    const zai = new ZaiProvider();
    const asBase = zai as unknown as { newClient: (k: string) => OpenAI };
    const fakeClient = {
      models: {
        list: async () => {
          throw new OpenAI.NotFoundError(
            404,
            { message: 'no such endpoint' },
            'not found',
            new Headers(),
          );
        },
      },
    } as unknown as OpenAI;
    asBase.newClient = () => fakeClient;
    await expect(zai.validateCredential({ provider: 'zai', apiKey: 'k' })).resolves.toBe(true);
  });
});

describe('ZaiProvider — GLM-5.x reasoning effort (user preference)', () => {
  it('injects reasoning_effort=low for GLM-5.x models', async () => {
    const zai = new ZaiProvider();
    const call = (zai as unknown as { requestExtras: (p: { model: string }) => Record<string, unknown> }).requestExtras;
    expect(call({ model: 'glm-5.3' })).toEqual({ reasoning_effort: 'low' });
    expect(call({ model: 'GLM-6.0' })).toEqual({ reasoning_effort: 'low' });
  });

  it('omits reasoning_effort for pre-5.x models (quarterly package switch needs no code)', async () => {
    const zai = new ZaiProvider();
    const call = (zai as unknown as { requestExtras: (p: { model: string }) => Record<string, unknown> }).requestExtras;
    expect(call({ model: 'glm-4.6' })).toEqual({});
    expect(call({ model: 'glm-4.7-flash' })).toEqual({});
  });
});
