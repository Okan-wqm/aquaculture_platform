/**
 * Species farm-AI read-only NATS responder (PR-4, Production specialist).
 * One `request.farm.ai.*` subject backed EXCLUSIVELY by the species module's
 * existing tenant-scoped CQRS query handler via QueryBus — no direct DB
 * access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isSpeciesListRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { ListSpeciesQuery } from '../queries/list-species.query';
import { Species } from '../entities/species.entity';
import { PaginatedQueryResult } from '@platform/cqrs';
import { SpeciesDto, projectSpecies } from './projections';

@Controller()
export class SpeciesAiQueryResponder {
  private readonly logger = new Logger(SpeciesAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.SPECIES_LIST)
  async list(@Payload() payload: unknown): Promise<AiQueryReply<AiQueryList<SpeciesDto>>> {
    return respondAiQuery(this.logger, payload, isSpeciesListRequest, async (req) => {
      const limit = clampListLimit(
        undefined,
        FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT,
      );
      const result = await this.queryBus.execute<
        ListSpeciesQuery,
        PaginatedQueryResult<Species>
      >(new ListSpeciesQuery(req.tenantId));
      return toBoundedList(result.data, limit, projectSpecies, result.pagination.total);
    });
  }
}
