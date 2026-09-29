import { Test } from '@nestjs/testing';

import { PersonaNotPermittedError } from '../../agent/agent-profile.service';
import { UnknownPersonaError } from '../../agent/agent-persona-catalogue.service';
import {
  AgentRunnerService,
  PersonaConversationMismatchError,
  type ChatRequest,
} from '../../agent/agent-runner.service';
import { AiChatResponder, type AiChatNatsRequest } from '../ai-chat.responder';
import { TenantBoundaryViolation } from '../../tenant-boundary/tenant-boundary-violation';

/**
 * AISAFETY-MEDIUM-024 at the NATS boundary: the responder forwards the
 * persona the caller named (or null → tenant default, resolved by the
 * runner), echoes the RESOLVED id in the reply metadata, and maps persona
 * outcomes to distinct error codes instead of a generic "temporarily
 * unavailable" (unknown / mismatch → BAD_REQUEST, not permitted → FORBIDDEN).
 */
describe('AiChatResponder persona forwarding + error codes', () => {
  const TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const USER_ID = '22222222-2222-4222-8222-222222222222';

  let responder: AiChatResponder;
  let agentRunner: { chat: jest.Mock };

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
        personaId: 'operator-v1',
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [AiChatResponder, { provide: AgentRunnerService, useValue: agentRunner }],
    }).compile();
    responder = moduleRef.get(AiChatResponder);
  });

  const baseRequest = (overrides: Partial<AiChatNatsRequest> = {}): AiChatNatsRequest => ({
    tenantId: TENANT_ID,
    userId: USER_ID,
    content: 'What is the DO level?',
    ...overrides,
  });

  it('forwards a named persona verbatim and null when none is named', async () => {
    await responder.handleChat(baseRequest({ persona: 'expert-farm-production-v1' }));
    expect(lastChatRequest().persona).toBe('expert-farm-production-v1');

    agentRunner.chat.mockClear();
    await responder.handleChat(baseRequest());
    expect(lastChatRequest().persona).toBeNull();
  });

  it('echoes the RESOLVED persona id in the reply metadata', async () => {
    const reply = await responder.handleChat(baseRequest());
    expect(reply.metadata).toMatchObject({ persona: 'operator-v1' });
    expect(reply.error).toBeUndefined();
  });

  it.each([
    [new UnknownPersonaError('bogus-v1'), 'BAD_REQUEST'],
    [new PersonaConversationMismatchError('operator-v1', 'expert-v1'), 'BAD_REQUEST'],
    [new PersonaNotPermittedError('supervisor-v1'), 'FORBIDDEN'],
  ])('maps %s to error code %s with the exception message', async (error, code) => {
    agentRunner.chat.mockRejectedValue(error);

    const reply = await responder.handleChat(baseRequest({ persona: 'supervisor-v1' }));

    expect(reply.error?.code).toBe(code);
    expect(reply.metadata).toMatchObject({ errorCode: code });
    expect(reply.content).toBe(error.message);
    expect(reply.conversationId).toBeNull();
  });

  it('still maps an unexpected failure to INTERNAL with the generic notice', async () => {
    agentRunner.chat.mockRejectedValue(new Error('provider exploded'));

    const reply = await responder.handleChat(baseRequest());

    expect(reply.error?.code).toBe('INTERNAL');
    expect(reply.content).not.toContain('provider exploded');
  });

  it('maps a tenant-boundary violation to TENANT_MISMATCH without naming any tenant', async () => {
    // SCENARIO: a tool reply was served for another tenant; the runner stopped the turn (K10).
    // EXPECTS: a fixed TENANT_MISMATCH reply — no tenant id, no tool data, no conversation.
    agentRunner.chat.mockRejectedValue(
      new TenantBoundaryViolation('request.farm.ai.getTankCapacity', 'reply_tenant_mismatch'),
    );

    const reply = await responder.handleChat(baseRequest());

    expect(reply.error?.code).toBe('TENANT_MISMATCH');
    expect(reply.metadata).toMatchObject({ errorCode: 'TENANT_MISMATCH' });
    expect(reply.conversationId).toBeNull();
    expect(reply.toolCalls).toBeUndefined();
    expect(JSON.stringify(reply)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('forwards no schema: the runner binds the tenant itself (K10)', async () => {
    await responder.handleChat(baseRequest());
    expect(lastChatRequest()).not.toHaveProperty('schemaName');
    expect(lastChatRequest().tenantId).toBe(TENANT_ID);
  });
});
