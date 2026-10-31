import { Test } from '@nestjs/testing';
import type { AiChatReplyFrame } from '@aquaculture/shared-contracts';
import { lastValueFrom, toArray } from 'rxjs';

import {
  AgentRunnerService,
  type ChatDraft,
  type ChatRequest,
  type ChatResponse,
} from '../../agent/agent-runner.service';
import { AiChatResponder, type AiChatNatsRequest } from '../ai-chat.responder';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const reply: ChatResponse = {
  conversationId: null,
  message: 'All good.',
  toolCalls: [],
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  personaId: 'operator-v1',
};

/**
 * MSG-MEDIUM-089: request.ai.chat answers a `stream: true` request with draft
 * frames while the reply is written, then the result; any other request
 * with the result alone, as before.
 */
describe('AiChatResponder reply frames (MSG-MEDIUM-089)', () => {
  let responder: AiChatResponder;
  let chat: jest.Mock<Promise<ChatResponse>, [ChatRequest, ((draft: ChatDraft) => void)?]>;

  beforeEach(async () => {
    // A runner that drafts two turns: a preamble before a tool call, then the reply.
    chat = jest.fn(async (_request: ChatRequest, onDraft?: (draft: ChatDraft) => void) => {
      onDraft?.({ turn: 1, text: 'Checking.' });
      onDraft?.({ turn: 2, text: 'All ' });
      onDraft?.({ turn: 2, text: 'good.' });
      return reply;
    });
    const moduleRef = await Test.createTestingModule({
      providers: [AiChatResponder, { provide: AgentRunnerService, useValue: { chat } }],
    }).compile();
    responder = moduleRef.get(AiChatResponder);
  });

  const request = (overrides: Partial<AiChatNatsRequest> = {}): AiChatNatsRequest => ({
    tenantId: TENANT_ID,
    userId: USER_ID,
    message: 'How are the tanks?',
    ...overrides,
  });

  const frames = (payload: AiChatNatsRequest): Promise<AiChatReplyFrame[]> =>
    lastValueFrom(responder.handleChat(payload).pipe(toArray()));

  it('streams the drafts, a turn per frame at most, then the result', async () => {
    const sent = await frames(request({ stream: true }));

    expect(sent.map((frame) => frame.type)).toEqual(['draft', 'draft', 'result']);
    expect(sent.slice(0, 2)).toEqual([
      { type: 'draft', turn: 1, text: 'Checking.' },
      // Turn 2 was written within one frame interval: one frame, sent before the result.
      { type: 'draft', turn: 2, text: 'All good.' },
    ]);
    expect(sent[2]).toMatchObject({ type: 'result', content: 'All good.' });
  });

  it('answers a request that does not stream with the result alone, asking the runner for no drafts', async () => {
    const sent = await frames(request());

    expect(sent).toEqual([expect.objectContaining({ type: 'result', content: 'All good.' })]);
    expect(chat.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('answers a refused request with the result alone, even when it asked to stream', async () => {
    const sent = await frames(request({ stream: true, tenantId: 'not-a-uuid' }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'result', error: { code: 'BAD_REQUEST' } });
    expect(chat).not.toHaveBeenCalled();
  });
});
