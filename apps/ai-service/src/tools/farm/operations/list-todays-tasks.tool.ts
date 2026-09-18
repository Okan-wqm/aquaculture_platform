import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AiQueryList, FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { LIST_LIMIT_SCHEMA } from '../farm-ai-query.schema';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { TaskReply, isAiListOf, isTask } from './reply-guards';

type Input = { limit?: number };

/** Today's tasks (priority order). */
@Injectable()
@Tool({
  name: 'list_todays_tasks',
  description:
    "Today's non-cancelled tasks ordered by priority then due time: title, category, " +
    'priority, status, due date/time, site, location and estimate. Use for the daily ' +
    'operations standup. Max 50 rows; narrow with limit when truncated.',
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
export class ListTodaysTasksTool extends FarmAiQueryTool<
  Input,
  { limit?: number },
  AiQueryList<TaskReply>
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.TASKS_TODAY);
  }

  protected isData(value: unknown): value is AiQueryList<TaskReply> {
    return isAiListOf(isTask)(value);
  }

  protected toRequestFields(input: Input) {
    return { limit: input.limit };
  }
}
