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
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { AiSafetyMiddleware } from '../../safety/ai-safety.middleware';

/**
 * ORPHAN-MEDIUM-380 / DB-PEOPLE-MEDIUM-002 — agent-runner cost accounting.
 *
 * Pins the two behavioural cures at the invocation boundary:
 *   1. The monthly token budget now bills cache-CREATION tokens (previously
 *      unbilled — cached-prompt tenants could write unbounded cache tokens
 *      outside the budget). Cache READS stay excluded (0.1x-discounted).
 *   2. Every completed invocation appends exactly ONE durable ledger row
 *      with the aggregated per-class token splits — and a ledger failure
 *      never fails the user's turn.
 */
describe('AgentRunnerService cost ledger + budget accounting (ORPHAN-MEDIUM-380)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const conversationId = '11111111-2222-3333-4444-555555555555';

  const chatRequest: ChatRequest = {
    message: 'How are my tanks doing?',
    persona: 'operator',
    tenantId,
    userId: '99999999-8888-7777-6666-555555555555',
    userRoles: ['operator'],
    resourcePermissions: ['ai_personas:operator'],
    schemaName: 'tenant_aaaaaaaabbbbcccc',
    correlationId: 'corr-1',
  };

  interface Harness {
    service: AgentRunnerService;
    recordTurn: jest.Mock;
    addUsage: jest.Mock;
    updateTokenCount: jest.Mock;
  }

  const buildHarness = async (options: {
    providerResponses: LlmChatResult[];
    flaggedPatterns?: string[];
    piiRedacted?: boolean;
    ledgerPersisted?: boolean;
  }): Promise<Harness> => {
    const recordTurn = jest.fn().mockResolvedValue(options.ledgerPersisted ?? true);
    const addUsage = jest.fn().mockResolvedValue(0);
    const updateTokenCount = jest.fn().mockResolvedValue(undefined);
    const chat = jest.fn();
    for (const response of options.providerResponses) {
      chat.mockResolvedValueOnce(response);
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
          },
        },
        {
          provide: ToolRegistryService,
          useValue: {
            getClaudeToolDefinitions: jest
              .fn()
              .mockReturnValue([{ name: 'test_tool', description: 'test', input_schema: {} }]),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {
            executeTool: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
          },
        },
        {
          provide: AgentProfileService,
          useValue: {
            resolveProfile: jest.fn().mockResolvedValue({
              persona: {
                name: 'operator',
                model: 'claude-haiku-4-5',
                maxTokensPerTurn: 4096,
                systemPrompt: 'You are the operator assistant.',
              },
              effectiveSystemPrompt: 'You are the operator assistant.',
              effectiveToolNames: ['test_tool'],
              actuationPolicy: 'confirm_required',
            }),
          },
        },
        {
          provide: ConversationService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: conversationId }),
            getById: jest.fn().mockResolvedValue(null),
            addMessage: jest.fn().mockResolvedValue(undefined),
            updateTokenCount,
          },
        },
        {
          provide: TokenBudgetService,
          useValue: {
            checkBudget: jest.fn().mockResolvedValue({
              allowed: true,
              used: 0,
              remaining: 1_000_000,
            }),
            addUsage,
          },
        },
        {
          provide: RateLimitService,
          useValue: {
            checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, resetAt: new Date() }),
          },
        },
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
              inputFilter: {
                safe: true,
                flaggedPatterns: options.flaggedPatterns ?? [],
                severity: 'clean',
              },
            }),
            validateToolCall: jest.fn().mockResolvedValue({ allowed: true }),
            postProcess: jest.fn((outputText: string) => ({
              outputText,
              piiRedacted: options.piiRedacted ?? false,
            })),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: {
            execute: jest.fn(({ fn }: { fn: () => Promise<LlmChatResult> }) => fn()),
          },
        },
        {
          provide: LlmProviderFactory,
          useValue: { get: jest.fn().mockReturnValue({ chat }) },
        },
      ],
    }).compile();

    return {
      service: moduleRef.get(AgentRunnerService),
      recordTurn,
      addUsage,
      updateTokenCount,
    };
  };

  const textTurn = (usage: LlmChatResult['usage']): LlmChatResult => ({
    content: [{ type: 'text', text: 'All tanks nominal.' }],
    stopReason: 'end_turn',
    usage,
  });

  it('bills cache-creation tokens into the monthly budget (cache reads stay excluded)', async () => {
    const harness = await buildHarness({
      providerResponses: [textTurn({ input: 100, output: 50, cacheRead: 30, cacheCreation: 20 })],
    });

    const response = await harness.service.chat(chatRequest);

    // total = input + output + cacheCreation (NOT cacheRead)
    expect(harness.addUsage).toHaveBeenCalledWith(tenantId, 170);
    expect(harness.updateTokenCount).toHaveBeenCalledWith(
      conversationId,
      tenantId,
      chatRequest.userId,
      170,
    );
    expect(response.tokenUsage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 30,
      cacheCreation: 20,
      total: 170,
    });
  });

  it('appends exactly one ledger row per invocation with token splits aggregated across the tool loop', async () => {
    const harness = await buildHarness({
      providerResponses: [
        {
          content: [{ type: 'tool_use', id: 'tu1', name: 'test_tool', input: {} }],
          stopReason: 'tool_use',
          usage: { input: 100, output: 10, cacheRead: 0, cacheCreation: 40 },
        },
        textTurn({ input: 200, output: 50, cacheRead: 30, cacheCreation: 0 }),
      ],
    });

    await harness.service.chat(chatRequest);

    // One row per completed INVOCATION — not per provider round-trip.
    expect(harness.recordTurn).toHaveBeenCalledTimes(1);
    expect(harness.recordTurn).toHaveBeenCalledWith({
      tenantId,
      conversationId,
      personaId: 'operator',
      model: 'claude-haiku-4-5',
      usage: { input: 300, output: 60, cacheRead: 30, cacheCreation: 40 },
      flaggedCategories: [],
    });
    // Budget across both loop iterations: 300 + 60 + 40 (cacheCreation billed)
    expect(harness.addUsage).toHaveBeenCalledWith(tenantId, 400);
  });

  it('carries safety flags into the ledger row', async () => {
    const harness = await buildHarness({
      providerResponses: [textTurn({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 })],
      flaggedPatterns: ['role_confusion'],
      piiRedacted: true,
    });

    await harness.service.chat(chatRequest);

    expect(harness.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        flaggedCategories: ['input:role_confusion', 'output:pii_redacted'],
      }),
    );
  });

  it('a failed ledger append does not fail the turn — budget and response still flow', async () => {
    const harness = await buildHarness({
      providerResponses: [textTurn({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 })],
      ledgerPersisted: false,
    });

    const response = await harness.service.chat(chatRequest);

    expect(harness.recordTurn).toHaveBeenCalledTimes(1);
    expect(response.message).toBe('All tanks nominal.');
    expect(harness.addUsage).toHaveBeenCalledWith(tenantId, 15);
  });
});
