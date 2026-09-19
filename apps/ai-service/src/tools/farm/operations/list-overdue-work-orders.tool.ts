import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type BoundedListRequest,
  type WorkOrdersReply,
  clampListLimit,
  isWorkOrdersReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS, LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';

interface Input {
  limit?: number;
}

@Injectable()
@Tool({
  name: 'list_overdue_work_orders',
  description:
    'Work orders past their due date and not completed: code, title, type, status, priority, asset, planned start, due date, estimated duration. Call first when asked what maintenance is late. Max 50 rows.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: LIST_LIMIT_SCHEMA },
  },
  requiresConfirmation: false,
})
export class ListOverdueWorkOrdersTool extends FarmAiQueryTool<
  Input,
  Omit<BoundedListRequest, 'tenantId'>,
  WorkOrdersReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.MAINT_OVERDUE_WORK_ORDERS;
  protected readonly isData = isWorkOrdersReply;

  protected toRequestFields(input: Input): Omit<BoundedListRequest, 'tenantId'> {
    return { limit: clampListLimit(input.limit) };
  }
}
