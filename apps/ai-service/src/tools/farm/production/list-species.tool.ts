import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { SpeciesReply, isAiListOf, isSpecies } from './reply-guards';

/** No input — the tenant's catalogue is small and server-bounded. */
type Input = Record<string, never>;

/** Species catalogue listing. */
@Injectable()
@Tool({
  name: 'list_species',
  description:
    'Species catalogue for the tenant: scientific/common/local names, code, ' +
    'category (cold/warm water…), water type and lifecycle status. Use to map a ' +
    'species name to its code before deeper queries.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class ListSpeciesTool extends FarmAiQueryTool<
  Input,
  Record<string, never>,
  AiQueryList<SpeciesReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.SPECIES_LIST);
  }

  protected isData(value: unknown): value is AiQueryList<SpeciesReply> {
    return isAiListOf(isSpecies)(value);
  }

  protected toRequestFields(): Record<string, never> {
    return {};
  }
}
