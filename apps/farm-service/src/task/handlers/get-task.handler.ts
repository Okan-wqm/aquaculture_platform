/**
 * Get Task Query Handler
 *
 * Reads a single task by id through the fail-closed tenant boundary, so the
 * lookup runs on a connection whose search_path + RLS GUC are verified for the
 * tenant (FARM-HIGH-060). A missing/stale tenant context throws TenantContextError
 * instead of silently returning null.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Task } from '../entities/task.entity';
import { GetTaskQuery } from '../queries/get-task.query';

@QueryHandler(GetTaskQuery)
export class GetTaskHandler implements IQueryHandler<GetTaskQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTaskQuery): Promise<Task> {
    const { tenantId, id } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const task = await queryRunner.manager.findOne(Task, { where: { id, tenantId } });
      if (!task) {
        throw new NotFoundException(`Görev bulunamadı: ${id}`);
      }
      return task;
    });
  }
}
