import { Test } from '@nestjs/testing';

import { AgentRunnerService, type ChatRequest } from '../../agent/agent-runner.service';
import { AiChatResponder, type AiChatNatsRequest } from '../ai-chat.responder';

/**
 * MSGFIX-FAZ2 2.3 — contextMessages mapping pins.
 *
 * The responder used to receive the messaging bridge's channel history and
 * silently DISCARD it (the field was never copied into ChatRequest), so AI
 * channels had zero memory. These tests pin the new contract: context →
 * priorMessages (user/assistant role projection, caps, malformed-entry
 * skipping) and the conversationId precedence rule.
 */
describe('AiChatResponder contextMessages mapping (MSGFIX-FAZ2)', () => {
  const TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const USER_ID = '22222222-2222-4222-8222-222222222222';

  let responder: AiChatResponder;
  let agentRunner: { chat: jest.Mock };

  /** Typed accessor for the ChatRequest the responder handed to the runner. */
  const lastChatRequest = (): ChatRequest => {
    const call: unknown[] = agentRunner.chat.mock.calls[0] as unknown[];
    return call[0] as ChatRequest;
  };

  beforeEach(async () => {
    agentRunner = {
      chat: jest.fn().mockResolvedValue({
        conversationId: 'conv-1',
        message: 'ok',
        toolCalls: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiChatResponder,
        { provide: AgentRunnerService, useValue: agentRunner },
      ],
    }).compile();
    responder = moduleRef.get(AiChatResponder);
  });

  const baseRequest = (overrides: Partial<AiChatNatsRequest> = {}): AiChatNatsRequest => ({
    tenantId: TENANT_ID,
    userId: USER_ID,
    content: 'What is the DO level?',
    ...overrides,
  });

  it('maps contextMessages to priorMessages (consented users → user, AI turns → assistant)', async () => {
    await responder.handleChat(
      baseRequest({
        contextMessages: [
          { senderId: 'u1', content: 'question from user 1', createdAt: '2026-09-16T10:00:00Z', isAi: false },
          { senderId: 'ai', content: 'assistant answer', createdAt: '2026-09-16T10:01:00Z', isAi: true },
        ],
      }),
    );

    const chatRequest = lastChatRequest();
    expect(chatRequest.priorMessages).toEqual([
      { role: 'user', content: 'question from user 1' },
      { role: 'assistant', content: 'assistant answer' },
    ]);
  });

  it('drops malformed and empty entries defensively (NATS trust boundary)', async () => {
    await responder.handleChat(
      baseRequest({
        contextMessages: [
          { senderId: 'u1', content: '', createdAt: '2026-09-16T10:00:00Z', isAi: false },
          { senderId: 'u2', content: '   ', createdAt: '2026-09-16T10:00:00Z', isAi: false },
          { senderId: 'u3', createdAt: '2026-09-16T10:00:00Z', isAi: false } as never,
          { senderId: 'u4', content: 'kept', createdAt: '2026-09-16T10:00:00Z', isAi: false },
        ],
      }),
    );

    const chatRequest = lastChatRequest();
    expect(chatRequest.priorMessages).toEqual([{ role: 'user', content: 'kept' }]);
  });

  it('caps history at 30 entries and 8000 chars per entry', async () => {
    const long = 'x'.repeat(9_000);
    await responder.handleChat(
      baseRequest({
        contextMessages: Array.from({ length: 40 }, (_, i) => ({
          senderId: `u${i}`,
          content: i === 0 ? long : `m${i}`,
          createdAt: '2026-09-16T10:00:00Z',
          isAi: false,
        })),
      }),
    );

    const chatRequest = lastChatRequest();
    expect(chatRequest.priorMessages).toHaveLength(30);
    expect(chatRequest.priorMessages?.[0]?.content).toHaveLength(8_000);
  });

  it('does NOT forward context when a conversationId rides the request (stored history wins)', async () => {
    await responder.handleChat(
      baseRequest({
        conversationId: 'conv-42',
        contextMessages: [
          { senderId: 'u1', content: 'should be ignored', createdAt: '2026-09-16T10:00:00Z', isAi: false },
        ],
      }),
    );

    const chatRequest = lastChatRequest();
    expect(chatRequest.conversationId).toBe('conv-42');
    expect(chatRequest.priorMessages).toBeUndefined();
  });

  it('undefined priorMessages when no context is supplied (assistant path unchanged)', async () => {
    await responder.handleChat(baseRequest());

    const chatRequest = lastChatRequest();
    expect(chatRequest.priorMessages).toBeUndefined();
  });
});
