import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA, OPTIONAL_UUID_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WqThresholdReply, isAiListOf, isWqThreshold } from './reply-guards';

interface Input {
  speciesId?: string;
  limit?: number;
}

/** The tenant's water-quality parameter thresholds (optimal/warning/critical). */
@Injectable()
@Tool({
  name: 'get_water_quality_thresholds',
  description:
    'Water-quality parameter thresholds per tenant: optimal/warning/critical min-max ' +
    'per parameter with unit (°C, mg/L, …), optionally narrowed to one speciesId. Use ' +
    'to judge whether readings are safe. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: { speciesId: OPTIONAL_UUID_SCHEMA, limit: LIST_LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetWaterQualityThresholdsTool extends FarmAiQueryTool<
  Input,
  { speciesId?: string },
  AiQueryList<WqThresholdReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.WQ_THRESHOLDS);
  }

  protected isData(value: unknown): value is AiQueryList<WqThresholdReply> {
    return isAiListOf(isWqThreshold)(value);
  }

  protected toRequestFields(input: Input): { speciesId?: string } {
    return { speciesId: input.speciesId };
  }
}
