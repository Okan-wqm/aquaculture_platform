import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProposedAction } from './proposed-action.entity';

import { ToolExecutorService } from '../tools/core/tool-executor.service';
import { ToolExecutionContext } from '../tools/core/tool.interface';

/**
 * MOB-HIGH-001 — the human-in-the-loop actuation state machine ("Faz 6").
 *
 * The agent loop persists every held `requiresConfirmation` tool call here via
 * {@link createProposal}; the confirm path (`request.ai.executeAction`, fired
 * by messaging-service's confirmAiAction after its channel-membership check)
 * lands in {@link executeProposal}, which:
 *
 *   1. loads the proposal WITHIN the tenant (cross-tenant ids resolve to
 *      nothing — the lookup itself is tenant-scoped),
 *   2. refuses proposals older than the confirmation window (a stale card
 *      must not actuate equipment/data hours later),
 *   3. claims `proposed → executing` ATOMICALLY (UPDATE … WHERE
 *      status='proposed'), so a double-confirm converges on ONE execution,
 *   4. executes the STORED tool + params — never caller-supplied ones — as
 *      the ORIGINAL requester (their roles are re-checked by the executor)
 *      with `actuationPolicy: 'allowed'`: the human confirmation IS the
 *      authorization override the policy was waiting for,
 *   5. persists the terminal state (completed/failed + result), and the
 *      executor writes the strict actuation audit row (tool_execution_audit).
 */

export interface CreateProposalInput {
  tenantId: string;
  toolName: string;
  params: Record<string, unknown>;
  description: string;
  requestedBy: string;
  requesterRoles: string[];
  persona: string;
  correlationId?: string;
}

export interface ProposalOutcome {
  success: boolean;
  result: string;
}

/** A proposal not confirmed within this window will not actuate. */
const CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ActionProposalService {
  private readonly logger = new Logger(ActionProposalService.name);

  constructor(
    @InjectRepository(ProposedAction)
    private readonly proposalRepo: Repository<ProposedAction>,
    private readonly toolExecutor: ToolExecutorService,
  ) {}

  async createProposal(input: CreateProposalInput): Promise<ProposedAction> {
    const proposal = this.proposalRepo.create({
      tenantId: input.tenantId,
      toolName: input.toolName,
      params: input.params,
      description: input.description,
      requestedBy: input.requestedBy,
      requesterRoles: input.requesterRoles,
      persona: input.persona,
      correlationId: input.correlationId,
      status: 'proposed',
    });
    const saved = await this.proposalRepo.save(proposal);
    this.logger.log(
      `Actuation proposal ${saved.id} created (tool=${input.toolName}, tenant=${input.tenantId})`,
    );
    return saved;
  }

  async executeProposal(
    actionId: string,
    tenantId: string,
    confirmedBy: string,
  ): Promise<ProposalOutcome> {
    // Tenant-scoped lookup: a cross-tenant id resolves to nothing.
    const proposal = await this.proposalRepo.findOne({ where: { id: actionId, tenantId } });
    if (!proposal) {
      this.logger.warn(
        `executeAction refused: proposal ${actionId} not found for tenant ${tenantId}`,
      );
      return { success: false, result: 'Proposed action not found.' };
    }

    // Idempotent convergence for terminal states.
    if (proposal.status === 'completed') {
      return { success: true, result: proposal.result ?? 'Action already executed.' };
    }
    if (proposal.status === 'failed') {
      return { success: false, result: proposal.result ?? 'Action previously failed.' };
    }
    if (proposal.status === 'executing') {
      return { success: false, result: 'Action is already executing.' };
    }

    // A stale confirmation must not actuate hours later.
    if (Date.now() - proposal.createdAt.getTime() > CONFIRMATION_WINDOW_MS) {
      await this.proposalRepo.update(
        { id: actionId },
        { status: 'failed', result: 'Proposal expired before confirmation.' },
      );
      return { success: false, result: 'Proposed action has expired — ask the AI again.' };
    }

    // Atomic claim: only ONE confirmer transitions proposed → executing.
    const claim = await this.proposalRepo.update(
      { id: actionId, tenantId, status: 'proposed' },
      { status: 'executing', confirmedBy },
    );
    if (!claim.affected) {
      // Lost the race — re-read for the converged outcome.
      const current = await this.proposalRepo.findOne({ where: { id: actionId, tenantId } });
      if (current?.status === 'completed') {
        return { success: true, result: current.result ?? 'Action already executed.' };
      }
      return { success: false, result: 'Action is already being executed.' };
    }

    // Execute the STORED intent as the ORIGINAL requester. The executor
    // re-checks the requester's roles against the tool's requiredPermissions
    // and writes the strict actuation audit row.
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    const context: ToolExecutionContext = {
      tenantId,
      schemaName: `tenant_${cleanId}`,
      userId: proposal.requestedBy,
      userRoles: proposal.requesterRoles,
      correlationId: proposal.correlationId ?? actionId,
      persona: proposal.persona,
      // The human confirmation IS the authorization override the
      // confirm_required policy was holding for.
      actuationPolicy: 'allowed',
    };

    try {
      const result = await this.toolExecutor.executeTool(
        proposal.toolName,
        proposal.params,
        context,
      );
      const resultText = result.success
        ? `${proposal.description} — done.`
        : `Action failed: ${result.error ?? 'unknown error'}`;
      await this.proposalRepo.update(
        { id: actionId },
        {
          status: result.success ? 'completed' : 'failed',
          result: resultText,
          executedAt: new Date(),
        },
      );
      return { success: result.success, result: resultText };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`executeAction ${actionId} crashed: ${message}`);
      await this.proposalRepo.update(
        { id: actionId },
        { status: 'failed', result: `Action failed: ${message}`, executedAt: new Date() },
      );
      return { success: false, result: `Action failed: ${message}` };
    }
  }
}
