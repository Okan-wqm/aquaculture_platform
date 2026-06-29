/**
 * List Tasks Query Handler
 *
 * Filtered, paginated task list read through the fail-closed tenant boundary
 * (FARM-HIGH-060). The count + page queries run on the same asserted connection.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import {
  IStandardPaginatedResult,
  createStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Task } from '../entities/task.entity';
import { ListTasksQuery } from '../queries/list-tasks.query';

@QueryHandler(ListTasksQuery)
export class ListTasksHandler implements IQueryHandler<ListTasksQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListTasksQuery): Promise<IStandardPaginatedResult<Task>> {
    const { tenantId, filter } = query;
    const limit = filter?.limit || 50;
    const offset = filter?.offset || 0;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const qb = queryRunner.manager
        .createQueryBuilder(Task, 'task')
        .where('task.tenantId = :tenantId', { tenantId });

      if (filter?.status?.length) {
        qb.andWhere('task.status IN (:...statuses)', { statuses: filter.status });
      }
      if (filter?.category?.length) {
        qb.andWhere('task.category IN (:...categories)', { categories: filter.category });
      }
      if (filter?.priority?.length) {
        qb.andWhere('task.priority IN (:...priorities)', { priorities: filter.priority });
      }
      if (filter?.assignedTo) {
        qb.andWhere('task.assignedTo = :assignedTo', { assignedTo: filter.assignedTo });
      }
      if (filter?.dateFrom) {
        qb.andWhere('task.dueDate >= :dateFrom', { dateFrom: new Date(filter.dateFrom) });
      }
      if (filter?.dateTo) {
        qb.andWhere('task.dueDate <= :dateTo', { dateTo: new Date(filter.dateTo) });
      }
      if (filter?.search) {
        qb.andWhere('(task.title ILIKE :search OR task.description ILIKE :search)', {
          search: `%${filter.search}%`,
        });
      }

      const total = await qb.getCount();

      qb.orderBy('task.dueDate', 'ASC')
        .addOrderBy(
          `CASE task.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END`,
          'ASC',
        )
        .skip(offset)
        .take(limit);

      const items = await qb.getMany();
      const page = Math.floor(offset / limit) + 1;
      return createStandardPaginatedResult(items, total, page, limit);
    });
  }
}
