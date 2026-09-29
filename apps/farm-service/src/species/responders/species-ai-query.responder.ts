import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus, type PaginatedQueryResult } from '@platform/cqrs';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isSpeciesListRequest,
  type TenantBoundReply,
  type SpeciesDto,
  type SpeciesListReply,
} from '@platform/event-contracts';
import { numberOrNull, toBoundedList } from '../../common/nats/ai-query-responder';
import { SpeciesFilterInput } from '../dto/species-filter.dto';
import type { Species } from '../entities/species.entity';
import { ListSpeciesQuery } from '../queries/list-species.query';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

export function projectSpecies(row: Species): SpeciesDto {
  const growth = row.growthParameters;
  return {
    id: row.id,
    code: row.code,
    commonName: row.commonName,
    scientificName: row.scientificName,
    category: row.category,
    waterType: row.waterType,
    isActive: row.isActive,
    maxDensityKgM3: numberOrNull(growth?.maxDensity),
    optimalDensityKgM3: numberOrNull(growth?.optimalDensity),
    avgDailyGrowthG: numberOrNull(growth?.avgDailyGrowth),
    avgHarvestWeightG: numberOrNull(growth?.avgHarvestWeight),
    avgTimeToHarvestDays: numberOrNull(growth?.avgTimeToHarvestDays),
    targetFcr: numberOrNull(growth?.targetFCR),
    maxFcr: numberOrNull(growth?.maxFCR),
    expectedSurvivalRatePct: numberOrNull(growth?.expectedSurvivalRate),
  };
}

/** Species targets for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class SpeciesAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.SPECIES_LIST)
  listSpecies(@Payload() payload: unknown): Promise<TenantBoundReply<SpeciesListReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.SPECIES_LIST,
        isRequest: isSpeciesListRequest,
        handle: async (req, scope) => {
          const filter = new SpeciesFilterInput();
          filter.isActive = true;
          filter.limit = FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT;
          filter.offset = 0;
          const page = await this.queryBus.execute<ListSpeciesQuery, PaginatedQueryResult<Species>>(
            new ListSpeciesQuery(scope, filter),
          );
          return toBoundedList(
            page.data,
            FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT,
            projectSpecies,
            page.pagination.total,
          );
        },
      },
      payload,
    );
  }
}
