import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type WorkOrderStatsReply,
  type WorkOrderStatsRequest,
  isWorkOrderStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, ISO_DATE_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  fromDate?: string;
  toDate?: string;
}

@Injectable()
@Tool({
  name: 'get_work_order_stats',
  description:
    'Work order counts by status, type and priority, overdue count, completed-on-time count, average completion minutes and total cost, optionally between two dates (YYYY-MM-DD).',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { fromDate: ISO_DATE_SCHEMA, toDate: ISO_DATE_SCHEMA },
  },
  requiresConfirmation: false,
})
export class GetWorkOrderStatsTool extends FarmAiQueryTool<
  Input,
  Omit<WorkOrderStatsRequest, 'tenantId'>,
  WorkOrderStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.MAINT_WORK_ORDER_STATS;
  protected readonly isData = isWorkOrderStatsReply;

  protected toRequestFields(input: Input): Omit<WorkOrderStatsRequest, 'tenantId'> {
    return {
      ...(input.fromDate ? { fromDate: input.fromDate } : {}),
      ...(input.toDate ? { toDate: input.toDate } : {}),
    };
  }
}
