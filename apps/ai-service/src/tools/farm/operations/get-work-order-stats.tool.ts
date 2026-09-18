import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { OPTIONAL_ISO_DATE_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WorkOrderStatsReply, isWorkOrderStats } from './reply-guards';

type Input = { fromDate?: string; toDate?: string };

/** Work order statistics. */
@Injectable()
@Tool({
  name: 'get_work_order_stats',
  description:
    'Work-order statistics for the tenant: totals by status/type/priority, overdue ' +
    'count, completed-on-time count, average completion time and total cost. ' +
    'Optional inclusive fromDate/toDate window (max 366 days) filters by creation date.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    properties: {
      fromDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window start' },
      toDate: { ...OPTIONAL_ISO_DATE_SCHEMA, description: 'Inclusive window end' },
    },
    additionalProperties: false,
  },
  requiresConfirmation: false,
})
export class GetWorkOrderStatsTool extends FarmAiQueryTool<
  Input,
  { fromDate?: string; toDate?: string },
  WorkOrderStatsReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS);
  }

  protected isData(value: unknown): value is WorkOrderStatsReply {
    return isWorkOrderStats(value);
  }

  protected toRequestFields(input: Input) {
    return { fromDate: input.fromDate, toDate: input.toDate };
  }
}
