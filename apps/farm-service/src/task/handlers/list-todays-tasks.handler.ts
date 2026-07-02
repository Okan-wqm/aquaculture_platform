/**
 * List Today's Tasks Query Handler
 *
 * Today's non-cancelled tasks, read through the fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Task, TaskStatus } from '../entities/task.entity';
import { ListTodaysTasksQuery } from '../queries/list-todays-tasks.query';

@QueryHandler(ListTodaysTasksQuery)
export class ListTodaysTasksHandler implements IQueryHandler<ListTodaysTasksQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListTodaysTasksQuery): Promise<Task[]> {
    const { tenantId } = query;
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      queryRunner.manager
        .createQueryBuilder(Task, 'task')
        .where('task.tenantId = :tenantId', { tenantId })
        .andWhere('task.dueDate >= :startOfDay', { startOfDay })
        .andWhere('task.dueDate < :endOfDay', { endOfDay })
        .andWhere('task.status != :cancelled', { cancelled: TaskStatus.CANCELLED })
        .orderBy('task.priority', 'ASC')
        .addOrderBy('task.dueTime', 'ASC')
        .getMany(),
    );
  }
}
