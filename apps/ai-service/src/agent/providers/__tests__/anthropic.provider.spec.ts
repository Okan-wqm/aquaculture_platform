import 'reflect-metadata';

// Mock the Anthropic SDK before importing the provider. The mock exposes the
// same error classes the provider narrows on (instanceof), a controllable
// messages.create, and records constructor calls so we can assert client reuse.
// The error classes and mock fns are declared at module scope (mock-prefixed so
// the hoisted jest.mock factory may close over them) and reused in the tests, so
// a rejected error is a genuine instance of the class the provider checks — no
// SDK type import (whose real ctor needs 4-5 args) and no cast.
const mockCreate = jest.fn();
const mockConstructor = jest.fn();
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

jest.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = Object.assign(
    jest.fn((opts: unknown) => {
      mockConstructor(opts);
      return { messages: { create: mockCreate } };
    }),
    {
      AuthenticationError: MockAuthenticationError,
      PermissionDeniedError: MockPermissionDeniedError,
    },
  );
  return {
    __esModule: true,
    default: MockAnthropic,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
  };
});

import { AnthropicProvider } from '../anthropic.provider';
import { LlmAuthError, LlmChatParams } from '../llm-provider.interface';

const CRED = { provider: 'anthropic' as const, apiKey: 'sk-ant-test-key' };

const CHAT_PARAMS: LlmChatParams = {
  model: 'claude-haiku-4-5',
  system: 'You are a test assistant.',
  maxTokens: 256,
  tools: [
    { name: 'get_x', description: 'gets x', inputSchema: { type: 'object' } },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    mockCreate.mockReset();
    mockConstructor.mockReset();
    provider = new AnthropicProvider();
  });

  it('translates a text+tool_use response into normalized blocks and usage', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 'tu_1', name: 'get_x', input: { a: 1 } },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
      stop_reason: 'tool_use',
    });

    const result = await provider.chat(CHAT_PARAMS, CRED);

    expect(result.content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'tu_1', name: 'get_x', input: { a: 1 } },
    ]);
    expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 3, cacheCreation: 2 });
    expect(result.stopReason).toBe('tool_use');
  });

  it('coalesces missing cache token classes to 0 (never NaN)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 4, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    const result = await provider.chat(CHAT_PARAMS, CRED);
    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheCreation).toBe(0);
    expect(result.stopReason).toBe('end_turn');
  });

  it('maps a rejected key to LlmAuthError (not a raw SDK error)', async () => {
    mockCreate.mockRejectedValue(new MockAuthenticationError('401'));

    await expect(provider.chat(CHAT_PARAMS, CRED)).rejects.toBeInstanceOf(LlmAuthError);
  });

  it('reuses one SDK client per distinct key (no per-request client churn)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });

    await provider.chat(CHAT_PARAMS, CRED);
    await provider.chat(CHAT_PARAMS, CRED);
    await provider.chat(CHAT_PARAMS, { provider: 'anthropic', apiKey: 'sk-ant-other' });

    // Two distinct keys → exactly two client constructions.
    expect(mockConstructor).toHaveBeenCalledTimes(2);
  });

  it('validateCredential returns true on a successful probe, false on auth failure', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'pong' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    });
    await expect(provider.validateCredential(CRED)).resolves.toBe(true);

    mockCreate.mockRejectedValueOnce(new MockAuthenticationError('401'));
    await expect(provider.validateCredential(CRED)).resolves.toBe(false);
  });

  it('validateCredential rethrows a transient (non-auth) failure rather than reporting the key invalid', async () => {
    mockCreate.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(provider.validateCredential(CRED)).rejects.toThrow('ECONNRESET');
  });
});
