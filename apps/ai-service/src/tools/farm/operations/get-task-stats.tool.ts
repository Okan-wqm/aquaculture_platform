import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { TaskStatsReply, isTaskStats } from './reply-guards';

/** No input — the tenant is taken from the (server-populated) context. */
type Input = Record<string, never>;

/** Task KPIs. */
@Injectable()
@Tool({
  name: 'get_task_stats',
  description:
    'Task KPIs for the tenant: totals for today (all vs completed), overdue count, ' +
    'upcoming (next 7 days) count, 30-day completion rate and average completion ' +
    'minutes.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresConfirmation: false,
})
export class GetTaskStatsTool extends FarmAiQueryTool<
  Input,
  Record<string, never>,
  TaskStatsReply
> {
  constructor(@Inject('NATS_SERVICE') nats: Pick<ClientProxy, 'send'>) {
    super(nats, FARM_AI_QUERY_SUBJECTS.TASK_STATS);
  }

  protected isData(value: unknown): value is TaskStatsReply {
    return isTaskStats(value);
  }

  protected toRequestFields(): Record<string, never> {
    return {};
  }
}
