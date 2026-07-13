import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActionProposalService } from './action-proposal.service';
import { AiActionResponder } from './ai-action.responder';
import { ProposedAction } from './proposed-action.entity';

import { ToolRegistryModule } from '../tools/tool-registry.module';

/**
 * MOB-HIGH-001 — human-in-the-loop actuation ("Faz 6"): proposal persistence,
 * the proposed→executing→completed/failed state machine, and the
 * `request.ai.executeAction` NATS responder that messaging-service's
 * confirmAiAction has been calling into the void.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProposedAction]), ToolRegistryModule],
  controllers: [AiActionResponder],
  providers: [ActionProposalService],
  exports: [ActionProposalService],
})
export class ActionsModule {}
