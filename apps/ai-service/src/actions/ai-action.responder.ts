import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { ActionProposalService } from './action-proposal.service';

/**
 * `request.ai.executeAction` NATS request-reply responder (MOB-HIGH-001).
 *
 * The other half of messaging-service's confirmAiAction: until now the subject
 * had a caller and NO responder, so every human confirmation timed out into
 * `{success:false}` and the AI-action capability was dead end-to-end.
 *
 * Contract (both sides updated together — the bridge now forwards the
 * `actionId` it stored in the proposed message's metadata):
 *   request:  { tenantId, actionId, actionType, params, confirmedBy }
 *   response: { success: boolean, result: string }
 *
 * `actionType`/`params` are advisory echoes of what the client SAW — execution
 * always runs the persisted proposal row (ActionProposalService), so a
 * tampered confirm payload cannot change what actuates. The channel-membership
 * authorization for the confirmer happened in messaging-service; this side
 * enforces tenant scoping, expiry and the atomic proposed→executing claim.
 */
export interface ExecuteActionNatsRequest {
  tenantId?: string;
  actionId?: string;
  actionType?: string;
  params?: Record<string, unknown>;
  confirmedBy?: string;
}

export interface ExecuteActionNatsResponse {
  success: boolean;
  result: string;
}

@Controller()
export class AiActionResponder {
  private readonly logger = new Logger(AiActionResponder.name);

  constructor(private readonly proposals: ActionProposalService) {}

  @MessagePattern('request.ai.executeAction')
  async handleExecuteAction(
    @Payload() payload: ExecuteActionNatsRequest,
  ): Promise<ExecuteActionNatsResponse> {
    const { tenantId, actionId, confirmedBy } = payload;
    if (!tenantId || !actionId || !confirmedBy) {
      this.logger.warn(
        'request.ai.executeAction rejected: tenantId, actionId and confirmedBy are required',
      );
      return {
        success: false,
        result: 'The action confirmation was missing required information.',
      };
    }

    try {
      return await this.proposals.executeProposal(actionId, tenantId, confirmedBy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`request.ai.executeAction failed for ${actionId}: ${message}`);
      return { success: false, result: 'Action execution failed. Please try again.' };
    }
  }
}
