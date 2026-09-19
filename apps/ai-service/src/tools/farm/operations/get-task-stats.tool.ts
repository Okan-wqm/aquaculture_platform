import { Injectable } from '@nestjs/common';
import {
  FARM_AI_QUERY_SUBJECTS,
  type TaskStatsReply,
  type TaskStatsRequest,
  isTaskStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

type Input = Record<string, never>;

@Injectable()
@Tool({
  name: 'get_task_stats',
  description:
    'Task counts for today (total, completed), overdue and upcoming counts, completion rate % and average completion minutes.',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  requiresConfirmation: false,
})
export class GetTaskStatsTool extends FarmAiQueryTool<
  Input,
  Omit<TaskStatsRequest, 'tenantId'>,
  TaskStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.TASK_STATS;
  protected readonly isData = isTaskStatsReply;

  protected toRequestFields(_input: Input): Omit<TaskStatsRequest, 'tenantId'> {
    return {};
  }
}
