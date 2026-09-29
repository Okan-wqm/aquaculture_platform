/**
 * List Today's Tasks Query Handler
 *
 * Today's non-cancelled tasks, read through the fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import { Task, TaskStatus } from '../entities/task.entity';
import { ListTodaysTasksQuery } from '../queries/list-todays-tasks.query';

@QueryHandler(ListTodaysTasksQuery)
export class ListTodaysTasksHandler implements IQueryHandler<ListTodaysTasksQuery> {
  async execute(query: ListTodaysTasksQuery): Promise<Task[]> {
    const { scope } = query;
    const tenantId = scope.tenantId;
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    return scope.manager
      .createQueryBuilder(Task, 'task')
      .where('task.tenantId = :tenantId', { tenantId })
      .andWhere('task.dueDate >= :startOfDay', { startOfDay })
      .andWhere('task.dueDate < :endOfDay', { endOfDay })
      .andWhere('task.status != :cancelled', { cancelled: TaskStatus.CANCELLED })
      .orderBy('task.priority', 'ASC')
      .addOrderBy('task.dueTime', 'ASC')
      .getMany();
  }
}
