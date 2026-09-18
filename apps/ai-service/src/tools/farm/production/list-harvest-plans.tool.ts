import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { HarvestPlanReply, isAiListOf, isHarvestPlan } from './reply-guards';

interface Input {
  scope: 'upcoming' | 'overdue';
  days: number;
  limit?: number;
}

/** Upcoming or overdue harvest plans. */
@Injectable()
@Tool({
  name: 'list_harvest_plans',
  description:
    "Harvest plans by scope: 'upcoming' (planned/approved/scheduled within the next `days` " +
    "days) or 'overdue' (past their planned date, still active). Rows carry plan code, " +
    'batch, status, harvest type, planned/window dates, target criteria and biomass ' +
    'estimates. Max 50 rows; narrow the window when truncated.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['upcoming', 'overdue'],
        description: 'Which plans to list',
      },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 180,
        default: 30,
        description: 'Forward window in days for scope=upcoming (1-180, default 30).',
      },
      limit: LIST_LIMIT_SCHEMA,
    },
    required: ['scope', 'days'],
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class ListHarvestPlansTool extends FarmAiQueryTool<
  Input,
  { scope: 'upcoming' | 'overdue'; days: number; limit?: number },
  AiQueryList<HarvestPlanReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.HARVEST_PLANS);
  }

  protected isData(value: unknown): value is AiQueryList<HarvestPlanReply> {
    return isAiListOf(isHarvestPlan)(value);
  }

  protected toRequestFields(input: Input) {
    return { scope: input.scope, days: input.days, limit: input.limit };
  }
}
