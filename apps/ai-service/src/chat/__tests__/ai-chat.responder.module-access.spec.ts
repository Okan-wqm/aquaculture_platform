import { Test } from '@nestjs/testing';

import { AgentRunnerService, type ChatRequest } from '../../agent/agent-runner.service';
import { AiChatResponder, type AiChatNatsRequest } from '../ai-chat.responder';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';

/**
 * RBAC-HIGH-028 on the AI chat path: request.ai.chat accepts the caller's module grants and
 * sites (ADR-051 §2 Transport) and carries them to the turn, so PKG-09 and PKG-12 can decide a
 * tool or persona by module. The request is a trust boundary: a malformed claim is refused as
 * BAD_REQUEST before anything runs, and an absent one means no grants (a sender of the previous
 * release, or the messaging bridge until PKG-25 forwards them).
 */
describe('AiChatResponder moduleAccess and assignedSiteIds (RBAC-HIGH-028)', () => {
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
      providers: [AiChatResponder, { provide: AgentRunnerService, useValue: agentRunner }],
    }).compile();
    responder = moduleRef.get(AiChatResponder);
  });

  const request = (
    overrides: Pick<AiChatNatsRequest, 'moduleAccess' | 'assignedSiteIds'> = {},
  ): AiChatNatsRequest => ({
    tenantId: TENANT_ID,
    userId: USER_ID,
    message: 'How are the tanks?',
    ...overrides,
  });

  it('carries the grants and the sites into the turn', async () => {
    await responder.handleChat(
      request({ moduleAccess: { farm: 'MODULE_USER' }, assignedSiteIds: [SITE_ID] }),
    );

    expect(lastChatRequest().moduleAccess).toEqual({ farm: 'MODULE_USER' });
    expect(lastChatRequest().assignedSiteIds).toEqual([SITE_ID]);
  });

  it('reads an absent claim as no grants and no sites', async () => {
    await responder.handleChat(request());

    expect(lastChatRequest().moduleAccess).toEqual({});
    expect(lastChatRequest().assignedSiteIds).toEqual([]);
  });

  it.each([
    ['a grant in a module that owns no data', { moduleAccess: { ai: 'MODULE_USER' } }],
    ['an account role as a grant', { moduleAccess: { farm: 'SUPER_ADMIN' } }],
    ['a list of codes', { moduleAccess: ['farm'] }],
    ['site ids that are not text', { assignedSiteIds: [42] }],
    ['a single site id', { assignedSiteIds: SITE_ID }],
  ])('refuses %s as BAD_REQUEST before the turn runs', async (_label, claim) => {
    const response = await responder.handleChat(request(claim));

    expect(response.error).toEqual(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(agentRunner.chat).not.toHaveBeenCalled();
  });
});
