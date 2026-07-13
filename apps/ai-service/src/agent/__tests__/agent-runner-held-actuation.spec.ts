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
import { AgentRunnerService, ChatRequest } from '../agent-runner.service';
import { LlmProviderFactory } from '../providers/llm-provider.factory';

/**
 * Held-actuation → persisted proposal (MOB-HIGH-001).
 *
 * When the executor holds a `requiresConfirmation` tool (confirm_required
 * actuation policy), the runner must:
 *   1. persist the FULL execution intent via ActionProposalService,
 *   2. surface { actionId, actionType, params, description } as
 *      ChatResponse.proposedAction (the confirmation card),
 *   3. tell the model the action is held (non-error tool_result) so it does
 *      not retry the tool.
 * Previously the pending result surfaced only as error text — nothing ever
 * created a card and confirmAiAction had nothing to execute.
 */
describe('AgentRunnerService held actuation (MOB-HIGH-001)', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const proposalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  let runner: AgentRunnerService;
  let createProposal: jest.Mock;
  let executeTool: jest.Mock;
  let providerChat: jest.Mock;

  beforeEach(async () => {
    createProposal = jest.fn().mockResolvedValue({
      id: proposalId,
      toolName: 'create_task',
      params: { title: 'Check pond 3', category: 'GENERAL', priority: 'MEDIUM', dueDate: '2026-07-13' },
      description: 'create_task: "Check pond 3"',
    });
    executeTool = jest.fn().mockResolvedValue({
      success: false,
      requiresConfirmation: true,
      error: 'Tool create_task requires human confirmation before execution',
      durationMs: 0,
      cacheable: false,
    });
    providerChat = jest
      .fn()
      // Turn 1: the model calls the actuation tool.
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'I will create that task for you.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'create_task',
            input: { title: 'Check pond 3', category: 'GENERAL', priority: 'MEDIUM', dueDate: '2026-07-13' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0, total: 20 },
      })
      // Turn 2: after the held notice, the model wraps up in text.
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Please confirm the card to create the task.' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0, total: 20 },
      });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        { provide: ConfigService, useValue: { get: jest.fn((_k: string, d: unknown) => d) } },
        {
          provide: ToolRegistryService,
          useValue: {
            getClaudeToolDefinitions: jest.fn().mockReturnValue([
              { name: 'create_task', description: 'x', input_schema: { type: 'object' } },
            ]),
          },
        },
        { provide: ToolExecutorService, useValue: { executeTool } },
        {
          provide: AgentProfileService,
          useValue: {
            resolveProfile: jest.fn().mockResolvedValue({
              persona: { name: 'operator-v1', systemPrompt: 'sys' },
              effectiveSystemPrompt: 'sys',
              effectiveToolNames: ['create_task'],
              actuationPolicy: 'confirm_required',
            }),
          },
        },
        {
          provide: ConversationService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
            getById: jest.fn().mockResolvedValue(null),
            addMessage: jest.fn().mockResolvedValue(undefined),
            updateTokenCount: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TokenBudgetService,
          useValue: {
            checkBudget: jest.fn().mockResolvedValue({ allowed: true, used: 0 }),
            addUsage: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RateLimitService,
          useValue: { checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }) },
        },
        // main's per-turn cost ledger (constructor index 7) — a stub keeps this
        // held-actuation suite focused on the proposal path.
        { provide: TurnLedgerService, useValue: { recordTurn: jest.fn() } },
        {
          provide: AgentConfigService,
          useValue: {
            resolveEnablement: jest.fn().mockResolvedValue({ enabled: true }),
            resolveCredential: jest.fn().mockResolvedValue({ provider: 'anthropic', apiKey: 'k' }),
            getConfig: jest.fn().mockResolvedValue({ hourlyRequestLimit: 60, monthlyTokenBudget: 1_000_000 }),
          },
        },
        {
          provide: AiSafetyMiddleware,
          useValue: {
            preProcess: jest.fn().mockReturnValue({ allowed: true }),
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
        { provide: ActionProposalService, useValue: { createProposal } },
      ],
    }).compile();

    runner = module.get(AgentRunnerService);
  });

  it('persists the held actuation as a proposal and surfaces the confirmation card', async () => {
    const request: ChatRequest = {
      message: 'remind me to check pond 3 tomorrow',
      persona: 'operator-v1',
      tenantId,
      userId,
      userRoles: ['operator'],
      resourcePermissions: [],
      schemaName: 'tenant_1111111111111111',
      correlationId: 'corr-1',
    };

    const response = await runner.chat(request);

    // The full execution intent is persisted with the requester's context.
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        toolName: 'create_task',
        requestedBy: userId,
        requesterRoles: ['operator'],
        persona: 'operator-v1',
      }),
    );
    // The card surfaces on the response.
    expect(response.proposedAction).toEqual(
      expect.objectContaining({ actionId: proposalId, actionType: 'create_task' }),
    );
    // The tool did NOT execute (held), and the model got a non-error notice —
    // second provider turn happened and closed with text.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(providerChat).toHaveBeenCalledTimes(2);
    expect(response.message).toContain('confirm');
  });
});
