/**
 * List My Tasks Query Handler
 *
 * Tasks assigned to a user, read through the fail-closed tenant boundary
 * (FARM-HIGH-060).
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Task } from '../entities/task.entity';
import { ListMyTasksQuery } from '../queries/list-my-tasks.query';

@QueryHandler(ListMyTasksQuery)
export class ListMyTasksHandler implements IQueryHandler<ListMyTasksQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListMyTasksQuery): Promise<Task[]> {
    const { tenantId, userId, statuses } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(Task, 'task')
        .where('task.tenantId = :tenantId', { tenantId })
        .andWhere('task.assignedTo = :userId', { userId });

      if (statuses?.length) {
        qb.andWhere('task.status IN (:...statuses)', { statuses });
      }

      return qb
        .orderBy('task.dueDate', 'ASC')
        .addOrderBy(
          `CASE task.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END`,
          'ASC',
        )
        .getMany();
    });
  }
}
