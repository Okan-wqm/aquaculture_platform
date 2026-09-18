import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import { AgentRunnerService, ChatRequest } from '../agent-runner.service';
import { AgentProfileService } from '../agent-profile.service';
import { LlmProviderFactory } from '../providers/llm-provider.factory';
import { LlmChatResult } from '../providers/llm-provider.interface';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { ToolExecutorService } from '../../tools/core/tool-executor.service';
import { ConversationService } from '../../conversation/conversation.service';
import { TokenBudgetService } from '../../cost/token-budget.service';
import { RateLimitService } from '../../cost/rate-limit.service';
import { TurnLedgerService } from '../../cost/turn-ledger.service';
import { ActionProposalService } from '../../actions/action-proposal.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { AiSafetyMiddleware } from '../../safety/ai-safety.middleware';

/**
 * FARM-AI Sprint 1.2 — ephemeral runs.
 *
 * Machine-driven calls (action_watch narratives, routine turns) must NEVER
 * occupy conversation storage: no agent_conversations row is created, no
 * user/assistant message is stored, no conversation aggregate is touched.
 * Cost accountability is NOT skipped — the durable ledger row keys on
 * correlationId + servicePrincipal instead of a conversation, and the token
 * budget still bills the turn. The rate-limit namespace rides the request so
 * service bursts get their own counter.
 */
describe('AgentRunnerService ephemeral runs (FARM-AI 1.2)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const ephemeralRequest: ChatRequest = {
    message: 'Narrate the verdict for watch #42',
    persona: 'narrator-v1',
    tenantId,
    userId: '99999999-8888-7777-6666-555555555555',
    userRoles: [],
    resourcePermissions: [],
    schemaName: 'tenant_aaaaaaaabbbbcccc',
    correlationId: 'corr-ephemeral-1',
    ephemeral: true,
    serviceId: 'farm_service',
    rateNamespace: 'routine',
  };

  const buildHarness = async (providerResponses: LlmChatResult[]) => {
    const chat = jest.fn();
    for (const response of providerResponses) {
      chat.mockResolvedValueOnce(response);
    }
    const conversationMocks = {
      create: jest.fn().mockResolvedValue({ id: 'must-not-be-created' }),
      getById: jest.fn().mockResolvedValue(null),
      addMessage: jest.fn().mockResolvedValue(undefined),
      updateTokenCount: jest.fn().mockResolvedValue(undefined),
    };
    const recordTurn = jest.fn().mockResolvedValue(true);
    const addUsage = jest.fn().mockResolvedValue(0);
    const checkRateLimit = jest.fn().mockResolvedValue({ allowed: true, resetAt: new Date() });
    const resolveProfile = jest.fn().mockResolvedValue({
      persona: {
        id: 'narrator-v1',
        name: 'Narrator',
        model: 'claude-haiku-4-5',
        maxTokensPerTurn: 2048,
        systemPrompt: 'Narrate only the evidence.',
      },
      baseSystemPrompt: 'Narrate only the evidence.',
      tenantCustomPrompt: null,
      effectiveToolNames: [],
      actuationPolicy: 'blocked',
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue) },
        },
        {
          provide: ToolRegistryService,
          useValue: { getClaudeToolDefinitions: jest.fn().mockReturnValue([]) },
        },
        {
          provide: ToolExecutorService,
          useValue: { executeTool: jest.fn() },
        },
        { provide: AgentProfileService, useValue: { resolveProfile } },
        { provide: ConversationService, useValue: conversationMocks },
        {
          provide: TokenBudgetService,
          useValue: {
            checkBudget: jest.fn().mockResolvedValue({ allowed: true, used: 0 }),
            addUsage,
          },
        },
        { provide: RateLimitService, useValue: { checkRateLimit } },
        { provide: TurnLedgerService, useValue: { recordTurn } },
        {
          provide: AgentConfigService,
          useValue: {
            resolveEnablement: jest.fn().mockResolvedValue({ enabled: true }),
            resolveCredential: jest.fn().mockResolvedValue({
              provider: 'anthropic',
              apiKey: 'sk-test',
            }),
            getConfig: jest.fn().mockResolvedValue({
              hourlyRequestLimit: 60,
              monthlyTokenBudget: 1_000_000,
            }),
          },
        },
        {
          provide: AiSafetyMiddleware,
          useValue: {
            preProcess: jest.fn().mockReturnValue({
              allowed: true,
              inputFilter: { safe: true, flaggedPatterns: [], severity: 'clean' },
            }),
            validateToolCall: jest.fn().mockResolvedValue({ allowed: true }),
            postProcess: jest.fn((outputText: string) => ({ outputText, piiRedacted: false })),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: { execute: jest.fn(({ fn }: { fn: () => Promise<LlmChatResult> }) => fn()) },
        },
        { provide: LlmProviderFactory, useValue: { get: jest.fn().mockReturnValue({ chat }) } },
        { provide: ActionProposalService, useValue: { createProposal: jest.fn() } },
      ],
    }).compile();

    return {
      service: moduleRef.get(AgentRunnerService),
      conversationMocks,
      resolveProfile,
      recordTurn,
      addUsage,
      checkRateLimit,
    };
  };

  const textTurn = (usage: LlmChatResult['usage']): LlmChatResult => ({
    content: [{ type: 'text', text: 'Watch #42 remains within bounds.' }],
    stopReason: 'end_turn',
    usage,
  });

  it('creates NO conversation and stores NO messages', async () => {
    const harness = await buildHarness([
      textTurn({ input: 100, output: 40, cacheRead: 0, cacheCreation: 0 }),
    ]);

    const response = await harness.service.chat(ephemeralRequest);

    expect(harness.conversationMocks.create).not.toHaveBeenCalled();
    expect(harness.conversationMocks.addMessage).not.toHaveBeenCalled();
    expect(harness.conversationMocks.updateTokenCount).not.toHaveBeenCalled();
    expect(response.conversationId).toBeNull();
    expect(response.message).toBe('Watch #42 remains within bounds.');
  });

  it('declares the calling service to the profile service (grant map input)', async () => {
    const harness = await buildHarness([
      textTurn({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }),
    ]);

    await harness.service.chat(ephemeralRequest);

    expect(harness.resolveProfile).toHaveBeenCalledWith(
      tenantId,
      'narrator-v1',
      expect.anything(),
      { serviceId: 'farm_service' },
    );
  });

  it('still bills the token budget and appends a ledger row keyed on correlationId + servicePrincipal', async () => {
    const harness = await buildHarness([
      textTurn({ input: 100, output: 40, cacheRead: 10, cacheCreation: 20 }),
    ]);

    await harness.service.chat(ephemeralRequest);

    expect(harness.addUsage).toHaveBeenCalledWith(tenantId, 160);
    expect(harness.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        conversationId: null,
        correlationId: 'corr-ephemeral-1',
        servicePrincipal: 'farm_service',
        personaId: 'narrator-v1',
      }),
    );
  });

  it('forwards the rate-limit namespace so service bursts use their own counter', async () => {
    const harness = await buildHarness([
      textTurn({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }),
    ]);

    await harness.service.chat(ephemeralRequest);

    expect(harness.checkRateLimit).toHaveBeenCalledWith(tenantId, 60, 'routine');
  });

  it('a non-ephemeral run still creates a conversation (legacy path unchanged)', async () => {
    const harness = await buildHarness([
      textTurn({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }),
    ]);

    const response = await harness.service.chat({
      ...ephemeralRequest,
      ephemeral: false,
      persona: 'operator-v1',
      rateNamespace: undefined,
    });

    expect(harness.conversationMocks.create).toHaveBeenCalledTimes(1);
    expect(response.conversationId).toBe('must-not-be-created');
  });
});
