import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ToolExecutorService } from '../../tools/core/tool-executor.service';
import { ActionProposalService } from '../action-proposal.service';
import { ProposedAction } from '../proposed-action.entity';

/**
 * ActionProposalService — the human-in-the-loop state machine (MOB-HIGH-001).
 *
 * Contract under test:
 *   - createProposal persists the FULL execution intent (tool, params, the
 *     ORIGINAL requester's authorization context) and returns the row.
 *   - executeProposal claims `proposed → executing` ATOMICALLY, executes the
 *     STORED params (never caller-supplied ones) with actuationPolicy
 *     'allowed' (the confirmation IS the authorization override), and lands on
 *     completed/failed with a persisted result.
 *   - a re-confirm of a completed proposal converges (returns the stored
 *     outcome, executes nothing) — double-taps cannot double-actuate.
 *   - unknown / cross-tenant / expired proposals refuse execution.
 */
describe('ActionProposalService (MOB-HIGH-001)', () => {
  let service: ActionProposalService;
  // Plain jest.fn properties (not a typed class mock) so assertions read the
  // mocks directly — sidesteps the unbound-method footgun on class prototypes.
  let repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let executor: { executeTool: jest.Mock };

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const actionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const requesterId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const confirmerId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  function proposalRow(overrides: Partial<ProposedAction> = {}): ProposedAction {
    return {
      id: actionId,
      tenantId,
      toolName: 'create_task',
      params: { title: 'Check pond 3', category: 'GENERAL', priority: 'MEDIUM', dueDate: '2026-07-13' },
      description: 'Create task "Check pond 3"',
      requestedBy: requesterId,
      requesterRoles: ['operator'],
      persona: 'operator-v1',
      correlationId: 'corr-1',
      status: 'proposed',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as ProposedAction;
  }

  beforeEach(async () => {
    executor = { executeTool: jest.fn() };
    repo = {
      create: jest.fn((v: Partial<ProposedAction>) => v),
      save: jest.fn((v: ProposedAction) => Promise.resolve({ ...v, id: actionId })),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActionProposalService,
        { provide: getRepositoryToken(ProposedAction), useValue: repo },
        { provide: ToolExecutorService, useValue: executor },
      ],
    }).compile();

    service = module.get(ActionProposalService);
  });

  it('createProposal persists the full execution intent and returns the row', async () => {
    const row = await service.createProposal({
      tenantId,
      toolName: 'create_task',
      params: { title: 'Check pond 3' },
      description: 'Create task "Check pond 3"',
      requestedBy: requesterId,
      requesterRoles: ['operator'],
      persona: 'operator-v1',
      correlationId: 'corr-1',
    });

    expect(row.id).toBe(actionId);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'proposed', requesterRoles: ['operator'] }),
    );
  });

  it('executeProposal claims atomically, runs the STORED params as the requester with policy allowed', async () => {
    repo.findOne.mockResolvedValue(proposalRow());
    executor.executeTool.mockResolvedValue({ success: true, data: { taskId: 't-1' }, durationMs: 5, cacheable: false });

    const outcome = await service.executeProposal(actionId, tenantId, confirmerId);

    // Atomic claim: UPDATE … WHERE status='proposed'.
    expect(repo.update).toHaveBeenCalledWith(
      { id: actionId, tenantId, status: 'proposed' },
      expect.objectContaining({ status: 'executing', confirmedBy: confirmerId }),
    );
    // Stored intent executes — as the ORIGINAL requester, policy 'allowed'.
    expect(executor.executeTool).toHaveBeenCalledWith(
      'create_task',
      expect.objectContaining({ title: 'Check pond 3' }),
      expect.objectContaining({
        tenantId,
        userId: requesterId,
        userRoles: ['operator'],
        actuationPolicy: 'allowed',
      }),
    );
    expect(outcome.success).toBe(true);
    // Terminal state persisted.
    expect(repo.update).toHaveBeenCalledWith(
      { id: actionId },
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('a failed tool run lands on failed with the error persisted', async () => {
    repo.findOne.mockResolvedValue(proposalRow());
    executor.executeTool.mockResolvedValue({ success: false, error: 'farm-service timeout', durationMs: 5, cacheable: false });

    const outcome = await service.executeProposal(actionId, tenantId, confirmerId);

    expect(outcome.success).toBe(false);
    expect(repo.update).toHaveBeenCalledWith(
      { id: actionId },
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('re-confirming a completed proposal converges without re-executing', async () => {
    repo.findOne.mockResolvedValue(proposalRow({ status: 'completed', result: 'Task created.' }));
    repo.update.mockResolvedValue({ affected: 0 });

    const outcome = await service.executeProposal(actionId, tenantId, confirmerId);

    expect(executor.executeTool).not.toHaveBeenCalled();
    expect(outcome.success).toBe(true);
    expect(outcome.result).toBe('Task created.');
  });

  it('refuses an unknown or cross-tenant proposal', async () => {
    repo.findOne.mockResolvedValue(null);

    const outcome = await service.executeProposal(actionId, tenantId, confirmerId);

    expect(outcome.success).toBe(false);
    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('refuses an expired proposal (older than the confirmation window)', async () => {
    repo.findOne.mockResolvedValue(
      proposalRow({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
    );

    const outcome = await service.executeProposal(actionId, tenantId, confirmerId);

    expect(outcome.success).toBe(false);
    expect(outcome.result).toMatch(/expired/i);
    expect(executor.executeTool).not.toHaveBeenCalled();
    // Expiry is persisted so the card cannot be retried forever.
    expect(repo.update).toHaveBeenCalledWith(
      { id: actionId },
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
