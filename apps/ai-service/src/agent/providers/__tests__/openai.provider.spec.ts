import 'reflect-metadata';

// Mock the OpenAI SDK before importing the provider. The mock exposes the same
// error classes the provider narrows on (instanceof via OpenAI.* statics), a
// controllable chat.completions.create + models.list, and records constructor
// calls so we can assert client reuse. Error classes and mock fns are declared
// at module scope (mock-prefixed so the hoisted jest.mock factory may close over
// them) — a rejected error is a genuine instance of the class the provider
// checks, with no SDK type import and no cast.
const mockCreate = jest.fn();
const mockList = jest.fn();
const mockConstructor = jest.fn();
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

jest.mock('openai', () => {
  const MockOpenAI = Object.assign(
    jest.fn((opts: unknown) => {
      mockConstructor(opts);
      return {
        chat: { completions: { create: mockCreate } },
        models: { list: mockList },
      };
    }),
    {
      AuthenticationError: MockAuthenticationError,
      PermissionDeniedError: MockPermissionDeniedError,
    },
  );
  return { __esModule: true, default: MockOpenAI };
});

import { OpenAiProvider } from '../openai.provider';
import { LlmAuthError, LlmChatParams } from '../llm-provider.interface';

const CRED = { provider: 'openai' as const, apiKey: 'sk-openai-test-key' };

const CHAT_PARAMS: LlmChatParams = {
  model: 'gpt-4o-mini',
  system: 'You are a test assistant.',
  maxTokens: 256,
  tools: [{ name: 'get_x', description: 'gets x', inputSchema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};

function okResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1 },
    ...overrides,
  };
}

describe('OpenAiProvider', () => {
  let provider: OpenAiProvider;

  beforeEach(() => {
    mockCreate.mockReset();
    mockList.mockReset();
    mockConstructor.mockReset();
    provider = new OpenAiProvider();
  });

  it('translates a text+tool_call response into normalized blocks and usage', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'thinking',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_x', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
    });

    const result = await provider.chat(CHAT_PARAMS, CRED);

    expect(result.content).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'call_1', name: 'get_x', input: { a: 1 } },
    ]);
    // OpenAI has no cache-creation class → 0; cache read comes from details.
    expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 3, cacheCreation: 0 });
    expect(result.stopReason).toBe('tool_use');
  });

  it('coalesces missing usage/cache fields to 0 (never NaN)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    });

    const result = await provider.chat(CHAT_PARAMS, CRED);
    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheCreation).toBe(0);
    expect(result.stopReason).toBe('end_turn');
  });

  it('flattens tool_result blocks into role:tool messages and tool_use into tool_calls', async () => {
    mockCreate.mockResolvedValue(okResponse());
    await provider.chat(
      {
        ...CHAT_PARAMS,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do it' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_9', name: 'get_x', input: { a: 1 } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'call_9', content: '42', isError: false }],
          },
        ],
      },
      CRED,
    );

    const calls = mockCreate.mock.calls as Array<[{ messages: Array<Record<string, unknown>> }]>;
    const sent = calls[0]?.[0];
    if (!sent) throw new Error('expected chat.completions.create to be called once');
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a test assistant.' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'do it' });
    expect(sent.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_9', type: 'function', function: { name: 'get_x', arguments: '{"a":1}' } },
      ],
    });
    expect(sent.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_9', content: '42' });
  });

  it('maps a rejected key to LlmAuthError (not a raw SDK error)', async () => {
    mockCreate.mockRejectedValue(new MockAuthenticationError('401'));
    await expect(provider.chat(CHAT_PARAMS, CRED)).rejects.toBeInstanceOf(LlmAuthError);
  });

  it('reuses one SDK client per distinct key (no per-request client churn)', async () => {
    mockCreate.mockResolvedValue(okResponse());
    await provider.chat(CHAT_PARAMS, CRED);
    await provider.chat(CHAT_PARAMS, CRED);
    await provider.chat(CHAT_PARAMS, { provider: 'openai', apiKey: 'sk-openai-other' });
    expect(mockConstructor).toHaveBeenCalledTimes(2);
  });

  it('validateCredential: true when models.list succeeds, false on auth failure', async () => {
    mockList.mockResolvedValueOnce({ data: [] });
    await expect(provider.validateCredential(CRED)).resolves.toBe(true);

    mockList.mockRejectedValueOnce(new MockAuthenticationError('401'));
    await expect(provider.validateCredential(CRED)).resolves.toBe(false);
  });

  it('validateCredential accepts a 403 (key valid, endpoint restricted)', async () => {
    mockList.mockRejectedValueOnce(new MockPermissionDeniedError('403'));
    await expect(provider.validateCredential(CRED)).resolves.toBe(true);
  });

  it('validateCredential rethrows a transient (non-auth) failure', async () => {
    mockList.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(provider.validateCredential(CRED)).rejects.toThrow('ECONNRESET');
  });
});
