/**
 * Tank farm-AI read-only NATS responder (PR-4, Production specialist —
 * TANK_CAPACITY is shared with the Operations specialist). One
 * `request.farm.ai.*` subject backed EXCLUSIVELY by the tank module's
 * existing tenant-scoped CQRS query handler via QueryBus — no direct DB
 * access, no commands, PII-free projection (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryReply,
  FARM_AI_QUERY_SUBJECTS,
  isTankCapacityRequest,
} from '@platform/event-contracts';

import { respondAiQuery } from '../../common/nats/ai-query-responder';
import { GetTankCapacityQuery, TankCapacityResult } from '../queries/get-tank-capacity.query';
import { TankCapacityDto, projectTankCapacity } from './projections';

@Controller()
export class TankAiQueryResponder {
  private readonly logger = new Logger(TankAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TANK_CAPACITY)
  async capacity(@Payload() payload: unknown): Promise<AiQueryReply<TankCapacityDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isTankCapacityRequest,
      async (req) =>
        projectTankCapacity(
          await this.queryBus.execute<GetTankCapacityQuery, TankCapacityResult>(
            new GetTankCapacityQuery(req.tenantId, req.tankId),
          ),
        ),
    );
  }
}
