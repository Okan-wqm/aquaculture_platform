import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import {
  LIST_LIMIT_SCHEMA,
  OPTIONAL_ISO_DATE_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
} from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WelfareReply, isAiListOf, isWelfare } from './reply-guards';

interface Input {
  siteId?: string;
  tankId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/** Welfare indicator scores (0-3 per indicator) per assessment. */
@Injectable()
@Tool({
  name: 'list_welfare_assessments',
  description:
    'Fish welfare assessments: gill/fin/wound/deformity scores (0 none to 3 severe), ' +
    'fish sampled, date. Optional siteId/tankId and ISO fromDate/toDate (window max 366 ' +
    'days); resolve tankId via get_farm_tanks first. Max 50 rows; narrow the window ' +
    'when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      siteId: OPTIONAL_UUID_SCHEMA,
      tankId: OPTIONAL_UUID_SCHEMA,
      fromDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window end' },
      limit: LIST_LIMIT_SCHEMA,
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListWelfareAssessmentsTool extends FarmAiQueryTool<
  Input,
  {
    siteId?: string;
    tankId?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
  },
  AiQueryList<WelfareReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.FH_WELFARE);
  }

  protected isData(value: unknown): value is AiQueryList<WelfareReply> {
    return isAiListOf(isWelfare)(value);
  }

  protected toRequestFields(input: Input) {
    return {
      siteId: input.siteId,
      tankId: input.tankId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      limit: input.limit,
    };
  }
}
