import { Test, TestingModule } from '@nestjs/testing';

import { ActionProposalService } from '../action-proposal.service';
import { AiActionResponder } from '../ai-action.responder';

/**
 * request.ai.executeAction responder (MOB-HIGH-001).
 *
 * This NATS subject existed only as a CALLER (messaging-service's
 * confirmAiAction) with nothing answering — every confirmation timed out into
 * `{success:false}`. The responder is the missing half: validate the envelope,
 * delegate to the proposal state machine, and always answer (never leave the
 * bridge to a timeout).
 */
describe('AiActionResponder (MOB-HIGH-001)', () => {
  let responder: AiActionResponder;
  let proposals: { executeProposal: jest.Mock };

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const actionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeEach(async () => {
    proposals = { executeProposal: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiActionResponder,
        { provide: ActionProposalService, useValue: proposals },
      ],
    }).compile();

    responder = module.get(AiActionResponder);
  });

  it('delegates a valid confirmation to the proposal state machine', async () => {
    proposals.executeProposal.mockResolvedValue({ success: true, result: 'Task created.' });

    const response = await responder.handleExecuteAction({
      tenantId,
      actionId,
      actionType: 'create_task',
      params: { title: 'x' },
      confirmedBy: userId,
    });

    expect(proposals.executeProposal).toHaveBeenCalledWith(actionId, tenantId, userId);
    expect(response).toEqual({ success: true, result: 'Task created.' });
  });

  it('rejects an envelope without an actionId — client params are never executed directly', async () => {
    const response = await responder.handleExecuteAction({
      tenantId,
      actionType: 'create_task',
      params: { title: 'attacker-controlled' },
      confirmedBy: userId,
    });

    expect(proposals.executeProposal).not.toHaveBeenCalled();
    expect(response.success).toBe(false);
  });

  it('rejects a missing tenant or confirmer', async () => {
    const noTenant = await responder.handleExecuteAction({
      actionId,
      actionType: 'create_task',
      confirmedBy: userId,
    });
    const noConfirmer = await responder.handleExecuteAction({
      tenantId,
      actionId,
      actionType: 'create_task',
    });

    expect(noTenant.success).toBe(false);
    expect(noConfirmer.success).toBe(false);
    expect(proposals.executeProposal).not.toHaveBeenCalled();
  });

  it('answers success:false instead of throwing when the state machine crashes', async () => {
    proposals.executeProposal.mockRejectedValue(new Error('db down'));

    const response = await responder.handleExecuteAction({
      tenantId,
      actionId,
      actionType: 'create_task',
      confirmedBy: userId,
    });

    expect(response.success).toBe(false);
  });
});
