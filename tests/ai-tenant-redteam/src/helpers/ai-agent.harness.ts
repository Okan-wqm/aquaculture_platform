import 'reflect-metadata';

import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { SecurityEventService } from '@aquaculture/backend-common/security';
import { collaborator } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { ActionProposalService } from '../../../../apps/ai-service/src/actions/action-proposal.service';
import { AgentProfileService } from '../../../../apps/ai-service/src/agent/agent-profile.service';
import { AgentRunnerService } from '../../../../apps/ai-service/src/agent/agent-runner.service';
import { LlmProviderFactory } from '../../../../apps/ai-service/src/agent/providers/llm-provider.factory';
import { AuditService } from '../../../../apps/ai-service/src/audit/audit.service';
import { ConversationService } from '../../../../apps/ai-service/src/conversation/conversation.service';
import { RateLimitService } from '../../../../apps/ai-service/src/cost/rate-limit.service';
import { TokenBudgetService } from '../../../../apps/ai-service/src/cost/token-budget.service';
import { TurnLedgerService } from '../../../../apps/ai-service/src/cost/turn-ledger.service';
import { AiSafetyMiddleware } from '../../../../apps/ai-service/src/safety/ai-safety.middleware';
import { TenantBoundNatsClient } from '../../../../apps/ai-service/src/tenant-boundary/tenant-bound-nats.client';
import { TenantBoundaryViolationReporter } from '../../../../apps/ai-service/src/tenant-boundary/tenant-boundary-violation.reporter';
import { AgentConfigService } from '../../../../apps/ai-service/src/tenant-config/agent-config.service';
import { ToolExecutorService } from '../../../../apps/ai-service/src/tools/core/tool-executor.service';
import { getToolMetadata } from '../../../../apps/ai-service/src/tools/core/tool.decorator';
import { GetFarmBatchesTool } from '../../../../apps/ai-service/src/tools/farm/get-farm-batches.tool';
import { GetFarmTanksTool } from '../../../../apps/ai-service/src/tools/farm/get-farm-tanks.tool';
import { GetBatchPerformanceTool } from '../../../../apps/ai-service/src/tools/farm/production/get-batch-performance.tool';
import { GetTankCapacityTool } from '../../../../apps/ai-service/src/tools/farm/production/get-tank-capacity.tool';
import { ToolRegistryService } from '../../../../apps/ai-service/src/tools/tool-registry.service';

import type { InProcessNatsTransport } from './in-process-nats.transport';
import type { ScriptedAttacker } from './scripted-attacker.provider';

/** The farm read tools the attacking agent is offered — the real classes, found by real discovery. */
const OFFERED_TOOLS = [
  GetTankCapacityTool,
  GetBatchPerformanceTool,
  GetFarmTanksTool,
  GetFarmBatchesTool,
] as const;

/** The tool names the persona offers — read from each class's own @Tool() metadata. */
function offeredToolNames(): string[] {
  return OFFERED_TOOLS.map((tool) => {
    const metadata = getToolMetadata(tool);
    if (metadata === undefined) throw new Error(`${tool.name} carries no @Tool() metadata`);
    return metadata.name;
  });
}

/** The audit writer's double, typed by the real signature so a spec reads rows without `any`. */
type AuditRowsMock = jest.Mock<Promise<void>, Parameters<AuditService['logToolExecution']>>;

/** What the red-team inspects after a turn. */
export interface AttackedAgent {
  readonly runner: AgentRunnerService;
  /** tool_execution_audit rows the executor wrote: [toolName, input, result, ctx, …]. */
  readonly auditRows: AuditRowsMock;
  /** TenantAccessDenied security events. */
  readonly securityEvents: jest.Mock;
  /** Messages persisted to the conversation (what a later turn would replay). */
  readonly persisted: jest.Mock;
  close(): Promise<void>;
}

/**
 * The REAL ai-service chat path for one tenant-A manager turn: AgentRunner →
 * ToolRegistry (DiscoveryService over the real tool classes) → ToolExecutor →
 * farm tools → TenantBoundNatsClient → the in-process transport.
 *
 * Doubles are limited to what is NOT the tenant boundary: the LLM (the
 * scripted attacker), persistence/cost ledgers, the tenant's AI enablement,
 * and the heuristic safety middleware — a pass-through ON PURPOSE: K10 must
 * hold even when the prompt-injection heuristics miss the attack.
 */
export async function buildAttackedAgent(
  transport: InProcessNatsTransport,
  attacker: ScriptedAttacker,
): Promise<AttackedAgent> {
  const auditRows: AuditRowsMock = jest
    .fn<Promise<void>, Parameters<AuditService['logToolExecution']>>()
    .mockResolvedValue(undefined);
  const securityEvents = jest.fn().mockResolvedValue(undefined);
  const persisted = jest.fn().mockResolvedValue(undefined);
  const reporter = new TenantBoundaryViolationReporter(
    collaborator<SecurityEventService>(
      { publishTenantAccessDenied: securityEvents },
      'SecurityEventService',
    ),
  );

  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [
      AgentRunnerService,
      ToolRegistryService,
      ToolExecutorService,
      ...OFFERED_TOOLS,
      { provide: TenantBoundNatsClient, useValue: new TenantBoundNatsClient(transport, reporter) },
      { provide: AuditService, useValue: { logToolExecution: auditRows } },
      { provide: ConfigService, useValue: { get: jest.fn((_k: string, d: unknown) => d) } },
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
            effectiveToolNames: offeredToolNames(),
            actuationPolicy: 'confirm_required',
          }),
        },
      },
      {
        provide: ConversationService,
        useValue: {
          create: jest.fn().mockResolvedValue({ id: 'conv-redteam' }),
          getById: jest.fn().mockResolvedValue(null),
          addMessage: persisted,
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
        useValue: { get: jest.fn().mockReturnValue({ chat: attacker.chat }) },
      },
      { provide: ActionProposalService, useValue: { createProposal: jest.fn() } },
    ],
  }).compile();
  // Runs ToolRegistryService.onModuleInit: real discovery + the boot-time
  // tenant-parameter refusal (K10 layer 2) over the offered tools.
  await moduleRef.init();

  return {
    runner: moduleRef.get(AgentRunnerService),
    auditRows,
    securityEvents,
    persisted,
    close: () => moduleRef.close(),
  };
}
