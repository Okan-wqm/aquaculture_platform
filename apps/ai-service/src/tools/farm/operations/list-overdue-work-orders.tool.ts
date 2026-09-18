import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { WorkOrderReply, isAiListOf, isWorkOrder } from './reply-guards';

type Input = { limit?: number };

/** Overdue work orders. */
@Injectable()
@Tool({
  name: 'list_overdue_work_orders',
  description:
    'Work orders past their due date and not yet completed: code, title, type, ' +
    'status, priority, asset, dates, durations and costs. Start here for ' +
    'maintenance triage. Max 50 rows; narrow with limit when truncated.',
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
export class ListOverdueWorkOrdersTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<WorkOrderReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.MAINT_OVERDUE_WORK_ORDERS);
  }

  protected isData(value: unknown): value is AiQueryList<WorkOrderReply> {
    return isAiListOf(isWorkOrder)(value);
  }

  protected toRequestFields(input: Input) {
    return { limit: input.limit };
  }
}
