/**
 * Get Task Stats Query Handler
 *
 * Aggregate task KPIs (today / overdue / upcoming / completion rate) read
 * through the fail-closed tenant boundary (FARM-HIGH-060). The raw aggregate
 * SQL runs on the asserted connection (search_path pinned to the tenant schema),
 * so the unqualified `FROM tasks` resolves to the correct tenant table instead
 * of silently aggregating the wrong/empty schema.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { TaskStatus } from '../entities/task.entity';
import { GetTaskStatsQuery } from '../queries/get-task-stats.query';

export interface TaskStatsResult {
  totalToday: number;
  completedToday: number;
  overdueCount: number;
  upcomingCount: number;
  completionRate: number;
  avgCompletionMinutes: number;
}

@QueryHandler(GetTaskStatsQuery)
export class GetTaskStatsHandler implements IQueryHandler<GetTaskStatsQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTaskStatsQuery): Promise<TaskStatsResult> {
    const { tenantId } = query;
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const endOfWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const [todayStats] = await queryRunner.manager.query(
        `SELECT
          COUNT(*) FILTER (WHERE "dueDate" >= $2 AND "dueDate" < $3 AND status != $4) AS "totalToday",
          COUNT(*) FILTER (WHERE "dueDate" >= $2 AND "dueDate" < $3 AND status = $5) AS "completedToday",
          COUNT(*) FILTER (WHERE status = $6) AS "overdueCount",
          COUNT(*) FILTER (WHERE "dueDate" >= $3 AND "dueDate" < $7 AND status IN ($8, $9)) AS "upcomingCount"
        FROM tasks
        WHERE "tenantId" = $1 AND "deletedAt" IS NULL`,
        [tenantId, startOfDay, endOfDay, TaskStatus.CANCELLED, TaskStatus.COMPLETED, TaskStatus.OVERDUE, endOfWeek, TaskStatus.PENDING, TaskStatus.IN_PROGRESS],
      );

      const [recentStats] = await queryRunner.manager.query(
        `SELECT
          COUNT(*) FILTER (WHERE status != $3) AS "totalRecent",
          COUNT(*) FILTER (WHERE status = $4) AS "completedRecent",
          AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) / 60)
            FILTER (WHERE status = $4 AND "completedAt" IS NOT NULL) AS "avgMinutes"
        FROM tasks
        WHERE "tenantId" = $1 AND "createdAt" >= $2 AND "deletedAt" IS NULL`,
        [tenantId, thirtyDaysAgo, TaskStatus.CANCELLED, TaskStatus.COMPLETED],
      );

      const totalRecent = parseInt(recentStats?.totalRecent || '0', 10);
      const completedRecent = parseInt(recentStats?.completedRecent || '0', 10);
      const completionRate = totalRecent > 0 ? Math.round((completedRecent / totalRecent) * 100) : 0;

      return {
        totalToday: parseInt(todayStats?.totalToday || '0', 10),
        completedToday: parseInt(todayStats?.completedToday || '0', 10),
        overdueCount: parseInt(todayStats?.overdueCount || '0', 10),
        upcomingCount: parseInt(todayStats?.upcomingCount || '0', 10),
        completionRate,
        avgCompletionMinutes: Math.round(parseFloat(recentStats?.avgMinutes || '0')),
      };
    });
  }
}
