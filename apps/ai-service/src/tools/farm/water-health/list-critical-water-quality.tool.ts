import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { CriticalWqReply, isAiListOf, isCriticalWq } from './reply-guards';

interface Input {
  limit?: number;
}

/** Tanks whose LATEST water-quality measurement is warning or critical. */
@Injectable()
@Tool({
  name: 'list_critical_water_quality',
  description:
    'Tanks whose latest water measurement is warning or critical (latest values with ' +
    'units, tank code/name, alarm flag; critical first). Call FIRST for urgent water ' +
    'safety questions. Max 50 rows; narrow with the stats/history tools when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { limit: LIST_LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListCriticalWaterQualityTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<CriticalWqReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.WQ_CRITICAL);
  }

  protected isData(value: unknown): value is AiQueryList<CriticalWqReply> {
    return isAiListOf(isCriticalWq)(value);
  }

  protected toRequestFields(input: Input): { limit?: number } {
    return { limit: input.limit };
  }
}
