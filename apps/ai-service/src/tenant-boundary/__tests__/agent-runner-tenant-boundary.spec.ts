import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';

import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { collaborator } from '@aquaculture/testing';

import { ActionProposalService } from '../../actions/action-proposal.service';
import { AgentProfileService } from '../../agent/agent-profile.service';
import { AgentRunnerService, ChatRequest } from '../../agent/agent-runner.service';
import { LlmProviderFactory } from '../../agent/providers/llm-provider.factory';
import type { LlmMessage } from '../../agent/providers/llm-provider.interface';
import { AuditService } from '../../audit/audit.service';
import { ConversationService } from '../../conversation/conversation.service';
import { RateLimitService } from '../../cost/rate-limit.service';
import { TokenBudgetService } from '../../cost/token-budget.service';
import { TurnLedgerService } from '../../cost/turn-ledger.service';
import { AiSafetyMiddleware } from '../../safety/ai-safety.middleware';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolExecutorService } from '../../tools/core/tool-executor.service';
import { GetTankCapacityTool } from '../../tools/farm/production/get-tank-capacity.tool';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { TenantBoundaryViolation } from '../tenant-boundary-violation';
import {
  TENANT_A,
  TENANT_B,
  boundReply,
  silentViolationReporter,
  tenantBoundClient,
} from './fixtures/tenant-bound.fixture';

/**
 * K10 red-team, ai-service half (PR-T1, MT-HIGH-062): a tenant-A chat turn,
 * driven by a model that tries to reach tenant B, through the REAL runner,
 * executor, farm tool and TenantBoundNatsClient. Only the LLM provider and the
 * NATS transport are doubles.
 *
 * What must hold:
 *   - a reply served for tenant B ends the run before a second model call —
 *     B's rows never enter the model's context, the tool result or toolCalls;
 *   - a prompt-injected tool call that names a tenant never leaves ai-service;
 *   - whatever the model asks for, the request names tenant A.
 */
describe('AgentRunnerService — tenant boundary (K10 / MT-HIGH-062)', () => {
  const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  /** A tank that exists only in tenant B — the model "knows" its id. */
  const TANK_OF_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const B_CAPACITY = {
    tankId: TANK_OF_B,
    tankCode: 'B-SECRET-01',
    tankName: 'Tenant B tank',
    volumeM3: 100,
    currentBiomassKg: 4242,
    capacityUsedPct: 91,
    densityStatus: 'critical',
    warnings: [],
  };

  let runner: AgentRunnerService;
  let send: jest.Mock;
  let providerChat: jest.Mock;
  let logToolExecution: jest.Mock;
  let reporter: ReturnType<typeof silentViolationReporter>;
  let reportSpy: jest.SpyInstance;
  let addMessage: jest.Mock;

  const request: ChatRequest = {
    message: 'How full is tank cccccccc-cccc-4ccc-8ccc-cccccccccccc?',
    persona: 'manager-farm-production-v1',
    tenantId: TENANT_A,
    userId: USER_ID,
    userRoles: ['MODULE_MANAGER'],
    resourcePermissions: [],
    correlationId: 'corr-k10',
  };

  const toolUseTurn = (input: Record<string, unknown>): unknown => ({
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_tank_capacity', input }],
    stopReason: 'tool_use',
    usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0, total: 20 },
  });
  const finalTurn = {
    content: [{ type: 'text', text: 'Done.' }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0, total: 20 },
  };

  /** Every text the model was shown across all provider calls. */
  const textShownToModel = (): string =>
    providerChat.mock.calls
      .map((call: unknown[]) => JSON.stringify((call[0] as { messages: LlmMessage[] }).messages))
      .join('\n');

  beforeEach(async () => {
    send = jest.fn();
    providerChat = jest.fn();
    logToolExecution = jest.fn().mockResolvedValue(undefined);
    addMessage = jest.fn().mockResolvedValue(undefined);
    reporter = silentViolationReporter();
    reportSpy = jest.spyOn(reporter, 'report');

    const tool = new GetTankCapacityTool(tenantBoundClient({ send }, reporter));
    const registry = {
      getTool: (name: string) => (name === 'get_tank_capacity' ? tool : undefined),
      getClaudeToolDefinitions: () => [
        {
          name: 'get_tank_capacity',
          description: tool.getMetadata().description,
          input_schema: tool.getMetadata().inputSchema,
        },
      ],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        { provide: ConfigService, useValue: { get: jest.fn((_k: string, d: unknown) => d) } },
        { provide: ToolRegistryService, useValue: registry },
        {
          provide: ToolExecutorService,
          useFactory: () =>
            new ToolExecutorService(
              collaborator<ToolRegistryService>(registry, 'ToolRegistryService'),
              collaborator<AuditService>({ logToolExecution }, 'AuditService'),
            ),
        },
        {
          provide: AgentProfileService,
          useValue: {
            resolveProfile: jest.fn().mockResolvedValue({
              persona: {
                id: 'manager-farm-production-v1',
                tier: 'manager',
                name: 'Production',
                maxTokensPerTurn: 1000,
              },
              baseSystemPrompt: 'sys',
              tenantCustomPrompt: null,
              effectiveToolNames: ['get_tank_capacity'],
              actuationPolicy: 'confirm_required',
            }),
          },
        },
        {
          provide: ConversationService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
            getById: jest.fn().mockResolvedValue(null),
            addMessage,
            updateTokenCount: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TokenBudgetService,
          useValue: {
            reserveBudget: jest.fn().mockResolvedValue(undefined),
            settleReservation: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RateLimitService,
          useValue: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) },
        },
        { provide: TurnLedgerService, useValue: { recordTurn: jest.fn() } },
        {
          provide: AgentConfigService,
          useValue: {
            resolveEnablement: jest.fn().mockResolvedValue({ enabled: true }),
            resolveCredential: jest.fn().mockResolvedValue({ provider: 'anthropic', apiKey: 'k' }),
            getConfig: jest
              .fn()
              .mockResolvedValue({ hourlyRequestLimit: 60, monthlyTokenBudget: 1_000_000 }),
          },
        },
        {
          provide: AiSafetyMiddleware,
          useValue: {
            scanUntrustedContext: jest.fn().mockReturnValue(true),
            preProcess: jest.fn().mockReturnValue({ allowed: true, systemPrompt: 'sys' }),
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

  it("stops the run when a reply is served for another tenant — B's data never reaches the model", async () => {
    // SCENARIO: the model asks for B's tank; a (faulty or hostile) responder answers with B's
    //           capacity and names tenant B.
    // EXPECTS: TenantBoundaryViolation ends the turn after ONE model call, the violation is
    //          reported and audited, and no text shown to the model or persisted contains B's data.
    providerChat.mockResolvedValueOnce(toolUseTurn({ tankId: TANK_OF_B }));
    providerChat.mockResolvedValueOnce(finalTurn);
    send.mockReturnValue(of(boundReply(B_CAPACITY, TENANT_B)));

    await expect(runner.chat(request)).rejects.toBeInstanceOf(TenantBoundaryViolation);

    // The request itself was bound to tenant A, whatever id the model chose.
    expect(send).toHaveBeenCalledWith('request.farm.ai.getTankCapacity', {
      tankId: TANK_OF_B,
      tenantId: TENANT_A,
    });
    expect(providerChat).toHaveBeenCalledTimes(1);
    expect(textShownToModel()).not.toContain('B-SECRET-01');
    expect(JSON.stringify(addMessage.mock.calls)).not.toContain('B-SECRET-01');
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTenantId: TENANT_A,
        servedTenantId: TENANT_B,
        correlationId: 'corr-k10',
      }),
    );
    expect(logToolExecution).toHaveBeenCalledWith(
      'get_tank_capacity',
      expect.any(Object),
      expect.objectContaining({ success: false, error: 'tenant_mismatch' }),
      expect.any(Object),
    );
  });

  it('refuses a prompt-injected tool call that names a tenant — nothing leaves ai-service', async () => {
    // SCENARIO: an injected instruction makes the model add `tenantId: B` to the tool call.
    // EXPECTS: the executor refuses before any NATS request; the model sees only the refusal.
    providerChat.mockResolvedValueOnce(toolUseTurn({ tankId: TANK_OF_B, tenantId: TENANT_B }));
    providerChat.mockResolvedValueOnce(finalTurn);

    const response = await runner.chat(request);

    expect(send).not.toHaveBeenCalled();
    expect(providerChat).toHaveBeenCalledTimes(2);
    expect(textShownToModel()).toContain('does not accept tenant or schema fields');
    expect(response.toolCalls).toEqual([
      expect.objectContaining({ name: 'get_tank_capacity', result: undefined }),
    ]);
  });

  it('control: a same-tenant reply reaches the model as the tool result', async () => {
    // SCENARIO: the responder answers for tenant A.
    // EXPECTS: the data is handed to the model on the second call.
    providerChat.mockResolvedValueOnce(toolUseTurn({ tankId: TANK_OF_B }));
    providerChat.mockResolvedValueOnce(finalTurn);
    send.mockReturnValue(of(boundReply({ ...B_CAPACITY, tankCode: 'A-OWN-01' }, TENANT_A)));

    const response = await runner.chat(request);

    expect(providerChat).toHaveBeenCalledTimes(2);
    expect(textShownToModel()).toContain('A-OWN-01');
    expect(response.message).toBe('Done.');
    expect(reportSpy).not.toHaveBeenCalled();
  });
});
