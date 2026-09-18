import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import {
  AgentRunnerService,
  ChatRequest,
  PersonaConversationMismatchError,
} from '../agent-runner.service';
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
 * FARM-AI PR-2 Commit B — single-exit prompt assembly + persona id discipline.
 *
 * 1. preProcess receives the SEPARATE parts (persona name, base prompt, tenant
 *    custom prompt) and its `systemPrompt` is exactly what the provider gets —
 *    the runner never merges prompts (the dropped-tenant-prompt hole, where
 *    hierarchy-on callers lost the tenant block, is structurally closed).
 * 2. `persona: null` resolves through the tenant's baseProfileId and every
 *    persisted string is the RESOLVED id.
 * 3. Continuing another persona's conversation throws
 *    PersonaConversationMismatchError instead of silently mixing assistants.
 */
describe('AgentRunnerService prompt assembly + persona discipline (FARM-AI PR-2 B)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const userId = '99999999-8888-7777-6666-555555555555';

  const baseRequest: ChatRequest = {
    message: 'summarize the tank',
    persona: null,
    tenantId,
    userId,
    userRoles: ['MODULE_USER'],
    resourcePermissions: ['ai_personas:operator'],
    schemaName: 'tenant_aaaaaaaabbbbcccc',
    correlationId: 'corr-prompt-1',
  };

  const buildHarness = async (options: {
    safetySystemPrompt?: string;
    existingConversation?: { id: string; persona: string; messages: unknown[] } | null;
    baseProfileId?: string;
  }) => {
    const providerChat = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    } satisfies LlmChatResult);
    const conversationMocks = {
      create: jest.fn().mockResolvedValue({ id: 'conv-new' }),
      getById: jest.fn().mockResolvedValue(options.existingConversation ?? null),
      addMessage: jest.fn().mockResolvedValue(undefined),
      updateTokenCount: jest.fn().mockResolvedValue(undefined),
    };
    const preProcess = jest.fn().mockReturnValue({
      allowed: true,
      inputFilter: { safe: true, flaggedPatterns: [], severity: 'clean' },
      systemPrompt: options.safetySystemPrompt ?? 'MIDDLEWARE-ASSEMBLED-PROMPT',
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        { provide: ConfigService, useValue: { get: jest.fn((_k: string, d?: unknown) => d) } },
        { provide: ToolRegistryService, useValue: { getClaudeToolDefinitions: jest.fn().mockReturnValue([]) } },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        {
          provide: AgentProfileService,
          useValue: {
            resolveProfile: jest.fn().mockResolvedValue({
              persona: {
                id: 'operator-v1',
                name: 'operator-v1',
                model: 'claude-haiku-4-5',
                maxTokensPerTurn: 4096,
                systemPrompt: 'BASE-PERSONA-PROMPT',
              },
              baseSystemPrompt: 'BASE-PERSONA-PROMPT',
              tenantCustomPrompt: 'TENANT-CUSTOM-BLOCK',
              personaTier: 'operator',
              effectiveToolNames: [],
              actuationPolicy: 'confirm_required',
            }),
          },
        },
        { provide: ConversationService, useValue: conversationMocks },
        {
          provide: TokenBudgetService,
          useValue: {
            checkBudget: jest.fn().mockResolvedValue({ allowed: true, used: 0 }),
            addUsage: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: RateLimitService,
          useValue: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, resetAt: new Date() }) },
        },
        { provide: TurnLedgerService, useValue: { recordTurn: jest.fn().mockResolvedValue(true) } },
        {
          provide: AgentConfigService,
          useValue: {
            resolveEnablement: jest.fn().mockResolvedValue({ enabled: true }),
            resolveCredential: jest.fn().mockResolvedValue({ provider: 'anthropic', apiKey: 'sk' }),
            getConfig: jest.fn().mockResolvedValue({
              hourlyRequestLimit: 60,
              monthlyTokenBudget: 1_000_000,
              baseProfileId: options.baseProfileId ?? 'operator-v1',
            }),
          },
        },
        { provide: AiSafetyMiddleware, useValue: { preProcess, postProcess: jest.fn((t: string) => ({ outputText: t, piiRedacted: false })) } },
        { provide: CircuitBreakerService, useValue: { execute: jest.fn(({ fn }: { fn: () => Promise<LlmChatResult> }) => fn()) } },
        { provide: LlmProviderFactory, useValue: { get: jest.fn().mockReturnValue({ chat: providerChat }) } },
        { provide: ActionProposalService, useValue: { createProposal: jest.fn() } },
      ],
    }).compile();

    return {
      service: moduleRef.get(AgentRunnerService),
      preProcess,
      providerChat,
      conversationMocks,
    };
  };

  it('preProcess receives the separate parts (base prompt + tenant custom) — the runner does not pre-merge', async () => {
    const harness = await buildHarness({});
    await harness.service.chat(baseRequest);

    expect(harness.preProcess).toHaveBeenCalledWith(
      'summarize the tank',
      tenantId,
      'operator-v1',
      'BASE-PERSONA-PROMPT',
      'TENANT-CUSTOM-BLOCK',
    );
  });

  it('the provider receives EXACTLY the middleware-assembled systemPrompt (single exit)', async () => {
    const harness = await buildHarness({ safetySystemPrompt: 'MIDDLEWARE-ASSEMBLED-PROMPT' });
    await harness.service.chat(baseRequest);

    const calls = harness.providerChat.mock.calls as unknown as Array<
      [{ system?: string }]
    >;
    const firstCall = calls[0];
    if (!firstCall) throw new Error('provider.chat was never called');
    expect(firstCall[0]?.system).toBe('MIDDLEWARE-ASSEMBLED-PROMPT');
  });

  it('persona null resolves through the tenant baseProfileId and persists the RESOLVED id', async () => {
    const harness = await buildHarness({ baseProfileId: 'operator-v1' });
    const response = await harness.service.chat(baseRequest);

    expect(harness.conversationMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'operator-v1' }),
    );
    expect(response.personaId).toBe('operator-v1');
  });

  it('continuing another persona conversation throws PersonaConversationMismatchError', async () => {
    const harness = await buildHarness({
      existingConversation: { id: 'conv-1', persona: 'expert-v1', messages: [] },
    });
    await expect(
      harness.service.chat({ ...baseRequest, conversationId: 'conv-1' }),
    ).rejects.toBeInstanceOf(PersonaConversationMismatchError);
    // No user message may be appended to a mismatched conversation.
    expect(harness.conversationMocks.addMessage).not.toHaveBeenCalled();
  });
});
