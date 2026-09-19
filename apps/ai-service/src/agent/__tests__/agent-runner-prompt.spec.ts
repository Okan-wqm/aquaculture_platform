import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { ActionProposalService } from '../../actions/action-proposal.service';
import { ConversationService } from '../../conversation/conversation.service';
import { RateLimitService } from '../../cost/rate-limit.service';
import { TokenBudgetService } from '../../cost/token-budget.service';
import { TurnLedgerService } from '../../cost/turn-ledger.service';
import { AiSafetyMiddleware } from '../../safety/ai-safety.middleware';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolExecutorService } from '../../tools/core/tool-executor.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { AgentProfileService } from '../agent-profile.service';
import {
  AgentRunnerService,
  ChatRequest,
  PersonaConversationMismatchError,
} from '../agent-runner.service';
import { LlmProviderFactory } from '../providers/llm-provider.factory';

/**
 * AISAFETY-MEDIUM-025 + AISAFETY-MEDIUM-024 at the runner:
 *   - the composed base prompt and the tenant custom prompt reach the safety
 *     pipeline SEPARATELY, and the provider receives exactly the prompt the
 *     pipeline assembled (no second assembly path in the runner);
 *   - a request naming no persona resolves the tenant default;
 *   - every persisted persona string is the RESOLVED catalogue id;
 *   - a conversation cannot be continued under a different persona.
 */
describe('AgentRunnerService prompt assembly + persona resolution', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  let runner: AgentRunnerService;
  let providerChat: jest.Mock;
  let preProcess: jest.Mock;
  let resolveProfile: jest.Mock;
  let createConversation: jest.Mock;
  let getById: jest.Mock;
  let recordTurn: jest.Mock;

  beforeEach(async () => {
    providerChat = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Tank 3 looks fine.' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 },
    });
    preProcess = jest.fn().mockReturnValue({
      allowed: true,
      systemPrompt: '[HARDENED] composed + tenant',
    });
    resolveProfile = jest.fn().mockResolvedValue({
      persona: {
        id: 'expert-farm-production-v1',
        tier: 'expert',
        name: 'Production Specialist (Expert)',
        model: 'claude-sonnet-5',
        maxTokensPerTurn: 16384,
        systemPrompt: 'COMPOSED',
      },
      baseSystemPrompt: 'COMPOSED',
      tenantCustomPrompt: 'Our site codes are A1..A9.',
      effectiveToolNames: [],
      actuationPolicy: 'confirm_required',
    });
    createConversation = jest.fn().mockResolvedValue({ id: 'conv-new' });
    getById = jest.fn().mockResolvedValue(null);
    recordTurn = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        { provide: ConfigService, useValue: { get: jest.fn((_k: string, d: unknown) => d) } },
        {
          provide: ToolRegistryService,
          useValue: { getClaudeToolDefinitions: jest.fn().mockReturnValue([]) },
        },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: AgentProfileService, useValue: { resolveProfile } },
        {
          provide: ConversationService,
          useValue: {
            create: createConversation,
            getById,
            addMessage: jest.fn().mockResolvedValue(undefined),
            updateTokenCount: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TokenBudgetService,
          useValue: {
            checkBudget: jest
              .fn()
              .mockResolvedValue({ allowed: true, used: 0, remaining: 1_000_000 }),
            addUsage: jest.fn().mockResolvedValue(undefined),
            reserveBudget: jest.fn().mockResolvedValue(undefined),
            settleReservation: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RateLimitService,
          useValue: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) },
        },
        { provide: TurnLedgerService, useValue: { recordTurn } },
        {
          provide: AgentConfigService,
          useValue: {
            resolveEnablement: jest.fn().mockResolvedValue({ enabled: true }),
            resolveCredential: jest.fn().mockResolvedValue({ provider: 'anthropic', apiKey: 'k' }),
            getConfig: jest.fn().mockResolvedValue({
              hourlyRequestLimit: 60,
              monthlyTokenBudget: 1_000_000,
              baseProfileId: 'operator-v1',
            }),
          },
        },
        {
          provide: AiSafetyMiddleware,
          useValue: {
            preProcess,
            scanUntrustedContext: jest.fn().mockReturnValue(true),
            postProcess: jest.fn((text: string) => ({ outputText: text, piiRedacted: false })),
            validateToolCall: jest.fn().mockResolvedValue({ allowed: true }),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: { execute: jest.fn(({ fn }: { fn: () => Promise<unknown> }) => fn()) },
        },
        {
          provide: LlmProviderFactory,
          useValue: { get: jest.fn().mockReturnValue({ chat: providerChat }) },
        },
        { provide: ActionProposalService, useValue: { createProposal: jest.fn() } },
      ],
    }).compile();

    runner = module.get(AgentRunnerService);
  });

  const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
    message: 'How is tank 3?',
    persona: 'expert-farm-production-v1',
    tenantId,
    userId,
    userRoles: ['MODULE_USER'],
    resourcePermissions: ['ai_personas:expert', 'ai_specialties:farm'],
    schemaName: 'tenant_1111111111111111',
    correlationId: 'corr-1',
    ...overrides,
  });

  it('hands the composed base prompt and the tenant prompt to the safety pipeline separately, and the provider gets the assembled prompt', async () => {
    await runner.chat(request());

    expect(preProcess).toHaveBeenCalledWith('How is tank 3?', tenantId, {
      personaName: 'Production Specialist (Expert)',
      baseSystemPrompt: 'COMPOSED',
      tenantCustomPrompt: 'Our site codes are A1..A9.',
    });
    expect(providerChat).toHaveBeenCalledWith(
      expect.objectContaining({ system: '[HARDENED] composed + tenant', model: 'claude-sonnet-5' }),
      expect.anything(),
    );
  });

  it('a request naming no persona resolves the tenant default persona', async () => {
    await runner.chat(request({ persona: null }));

    expect(resolveProfile).toHaveBeenCalledWith(
      tenantId,
      'operator-v1',
      expect.anything(),
      // FARM-AI Sprint 1.2: the runner always declares the (possibly absent)
      // calling-service identity for the service→persona grant map.
      { serviceId: undefined },
    );
  });

  it('persists the RESOLVED persona id on the conversation, the ledger and the response', async () => {
    const response = await runner.chat(request({ persona: 'expert-farm-production-v1' }));

    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'expert-farm-production-v1' }),
    );
    expect(recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'expert-farm-production-v1' }),
    );
    expect(response.personaId).toBe('expert-farm-production-v1');
  });

  it('refuses to continue a conversation under a different persona', async () => {
    getById.mockResolvedValue({ id: 'conv-1', persona: 'operator-v1', messages: [] });

    await expect(runner.chat(request({ conversationId: 'conv-1' }))).rejects.toBeInstanceOf(
      PersonaConversationMismatchError,
    );
    expect(providerChat).not.toHaveBeenCalled();
  });

  it('rejects the turn before the provider when the safety pipeline blocks the input', async () => {
    preProcess.mockReturnValue({ allowed: false, rejectionReason: 'jailbreak' });

    await expect(runner.chat(request())).rejects.toThrow(/flagged by our safety system/);
    expect(providerChat).not.toHaveBeenCalled();
  });
});
