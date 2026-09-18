/**
 * Task farm-AI read-only NATS responder (PR-5, Operations specialist). Two
 * `request.farm.ai.*` subjects backed EXCLUSIVELY by the task module's
 * existing tenant-scoped CQRS query handlers via QueryBus — no direct DB
 * access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryList,
  AiQueryReply,
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isTaskStatsRequest,
  isTodaysTasksRequest,
} from '@platform/event-contracts';

import { clampListLimit, respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { ListTodaysTasksQuery } from '../queries/list-todays-tasks.query';
import { GetTaskStatsQuery } from '../queries/get-task-stats.query';
import { TaskStatsResult } from '../handlers/get-task-stats.handler';
import { Task } from '../entities/task.entity';
import { TaskDto, projectTask } from './projections';

@Controller()
export class TaskAiQueryResponder {
  private readonly logger = new Logger(TaskAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TASKS_TODAY)
  async today(@Payload() payload: unknown): Promise<AiQueryReply<AiQueryList<TaskDto>>> {
    return respondAiQuery(
      this.logger,
      payload,
      isTodaysTasksRequest,
      async (req) =>
        toBoundedList(
          await this.queryBus.execute<ListTodaysTasksQuery, Task[]>(
            new ListTodaysTasksQuery(req.tenantId),
          ),
          clampListLimit(req.limit, FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT),
          projectTask,
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TASK_STATS)
  async stats(@Payload() payload: unknown): Promise<AiQueryReply<TaskStatsResult>> {
    return respondAiQuery(
      this.logger,
      payload,
      isTaskStatsRequest,
      async (req) =>
        await this.queryBus.execute<GetTaskStatsQuery, TaskStatsResult>(
          new GetTaskStatsQuery(req.tenantId),
        ),
    );
  }
}
