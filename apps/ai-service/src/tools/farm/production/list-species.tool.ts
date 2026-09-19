import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type SpeciesListReply,
  type SpeciesListRequest,
  isSpeciesListReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

type Input = Record<string, never>;

@Injectable()
@Tool({
  name: 'list_species',
  description:
    "The tenant's active species with their production targets: max/optimal density kg/m3, avg daily growth g, avg harvest weight g, days to harvest, target and max FCR, expected survival %. Use these as the benchmark when judging batch performance.",
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  requiresConfirmation: false,
})
export class ListSpeciesTool extends FarmAiQueryTool<
  Input,
  Omit<SpeciesListRequest, 'tenantId'>,
  SpeciesListReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.SPECIES_LIST;
  protected readonly isData = isSpeciesListReply;

  protected toRequestFields(_input: Input): Omit<SpeciesListRequest, 'tenantId'> {
    return {};
  }
}
