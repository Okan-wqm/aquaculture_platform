import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isBoundedListRequest,
  isTaskStatsRequest,
  toEventIso,
  type TenantBoundReply,
  type TaskDto,
  type TaskStatsReply,
  type TasksReply,
} from '@platform/event-contracts';
import { numberOrNull, toBoundedList } from '../../common/nats/ai-query-responder';
import type { Task } from '../entities/task.entity';
import type { TaskStatsResult } from '../handlers/get-task-stats.handler';
import { GetTaskStatsQuery } from '../queries/get-task-stats.query';
import { ListTodaysTasksQuery } from '../queries/list-todays-tasks.query';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

/** No assignee, creator, notes or checklist text crosses — only checklist progress. */
export function projectTask(row: Task): TaskDto {
  const checklist = row.checklistItems ?? [];
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    priority: row.priority,
    status: row.status,
    dueDate: toEventIso(row.dueDate),
    dueTime: row.dueTime ?? null,
    siteId: row.siteId ?? null,
    location: row.location ?? null,
    estimatedMinutes: numberOrNull(row.estimatedMinutes),
    isRecurring: row.isRecurring,
    checklistTotal: checklist.length,
    checklistDone: checklist.filter((item) => item.isCompleted === true || item.completed === true)
      .length,
  };
}

export function projectTaskStats(stats: TaskStatsResult): TaskStatsReply {
  return {
    totalToday: stats.totalToday,
    completedToday: stats.completedToday,
    overdueCount: stats.overdueCount,
    upcomingCount: stats.upcomingCount,
    completionRatePct: Number(stats.completionRate),
    avgCompletionMinutes: Number(stats.avgCompletionMinutes),
  };
}

/** Task read surface for the farm operations specialist (FARM-MEDIUM-328). */
@Controller()
export class TaskAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TASKS_TODAY)
  listTodaysTasks(@Payload() payload: unknown): Promise<TenantBoundReply<TasksReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.TASKS_TODAY,
        isRequest: isBoundedListRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<ListTodaysTasksQuery, Task[]>(
            new ListTodaysTasksQuery(scope),
          );
          return toBoundedList(rows, req.limit, projectTask);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.TASK_STATS)
  getStats(@Payload() payload: unknown): Promise<TenantBoundReply<TaskStatsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.TASK_STATS,
        isRequest: isTaskStatsRequest,
        handle: async (req, scope) => {
          const stats = await this.queryBus.execute<GetTaskStatsQuery, TaskStatsResult>(
            new GetTaskStatsQuery(scope),
          );
          return projectTaskStats(stats);
        },
      },
      payload,
    );
  }
}
