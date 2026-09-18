import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import {
  ISO_DATE_SCHEMA,
  LIST_LIMIT_SCHEMA,
  UUID_SCHEMA,
} from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WqPointReply, isAiListOf, isWqPoint } from './reply-guards';

interface Input {
  tankId: string;
  fromDate: string;
  toDate: string;
  limit?: number;
}

/** Time-ordered water-quality measurement history for one tank. */
@Injectable()
@Tool({
  name: 'get_water_quality_history',
  description:
    'Water-quality measurement history for one tank (temperature °C, dissolved oxygen ' +
    'mg/L, pH, ammonia mg/L, nitrite mg/L, status per point, oldest first). Window max ' +
    '90 days; resolve tankId via get_farm_tanks first. Max 50 rows; narrow the window ' +
    'when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      tankId: UUID_SCHEMA,
      fromDate: ISO_DATE_SCHEMA,
      toDate: ISO_DATE_SCHEMA,
      limit: LIST_LIMIT_SCHEMA,
    },
    required: ['tankId', 'fromDate', 'toDate'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetWaterQualityHistoryTool extends FarmAiQueryTool<
  Input,
  { tankId: string; fromDate: string; toDate: string; limit?: number },
  AiQueryList<WqPointReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.WQ_HISTORY);
  }

  protected isData(value: unknown): value is AiQueryList<WqPointReply> {
    return isAiListOf(isWqPoint)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      tankId: input.tankId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      limit: input.limit,
    };
  }
}
