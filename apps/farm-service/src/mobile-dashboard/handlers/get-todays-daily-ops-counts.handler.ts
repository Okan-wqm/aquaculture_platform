/**
 * Get Today's Daily-Ops Counts Query Handler — fail-closed tenant boundary
 * (FARM-HIGH-060).
 *
 * The four aggregates run SEQUENTIALLY (not Promise.all): runInTenantRead pins a
 * single tenant-asserted connection, and one pg connection cannot service
 * concurrent queries. The day-boundary resolution (FARM-MEDIUM-053/056) is
 * preserved verbatim.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { MortalityRecord } from '../../batch/entities/mortality-record.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import {
  DailyFeedingExecution,
  ExecutionStatus,
} from '../../feeding/entities/daily-feeding-execution.entity';
import { WaterQualityMeasurement } from '../../water-quality/entities/water-quality-measurement.entity';
import { TodaysDailyOpsCounts } from '../dto/mobile-dashboard.dto';
import { GetTodaysDailyOpsCountsQuery } from '../queries/get-todays-daily-ops-counts.query';

@QueryHandler(GetTodaysDailyOpsCountsQuery)
export class GetTodaysDailyOpsCountsHandler
  implements IQueryHandler<GetTodaysDailyOpsCountsQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTodaysDailyOpsCountsQuery): Promise<TodaysDailyOpsCounts> {
    const { tenantId, clientDate } = query;

    const timeZone = process.env.FARM_DASHBOARD_TIME_ZONE ?? 'UTC';
    const today = this.resolveCalendarDay(clientDate, timeZone);
    const tomorrow = new Date(`${today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const todayStart = new Date(`${today}T00:00:00.000Z`);

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const m = queryRunner.manager;

      const mortalityRaw = await m
        .createQueryBuilder(MortalityRecord, 'mortality')
        .select('COALESCE(SUM(mortality.count), 0)', 'mortalityCount')
        .where('mortality.tenantId = :tenantId', { tenantId })
        .andWhere('mortality.recordDate = :today', { today })
        .getRawOne<{ mortalityCount: string }>();

      const cullRaw = await m
        .createQueryBuilder(TankOperation, 'operation')
        .select('COALESCE(SUM(operation.quantity), 0)', 'cullCount')
        .where('operation.tenantId = :tenantId', { tenantId })
        .andWhere('operation.operationType = :cull', { cull: OperationType.CULL })
        .andWhere('operation.isDeleted = false')
        .andWhere('operation.operationDate = :today', { today })
        .getRawOne<{ cullCount: string }>();

      const wqReadingsCount = await m
        .createQueryBuilder(WaterQualityMeasurement, 'measurement')
        .where('measurement.tenantId = :tenantId', { tenantId })
        .andWhere('measurement.measuredAt >= :todayStart', { todayStart })
        .andWhere('measurement.measuredAt < :tomorrow', { tomorrow })
        .getCount();

      const feedingRaw = await m
        .createQueryBuilder(DailyFeedingExecution, 'execution')
        .select('COUNT(*)', 'feedingTotalCount')
        .addSelect(
          'COUNT(*) FILTER (WHERE execution.status = :completed)',
          'feedingCompletedCount',
        )
        .where('execution.tenantId = :tenantId', { tenantId })
        .andWhere('execution.executionDate = :today', { today })
        .setParameter('completed', ExecutionStatus.COMPLETED)
        .getRawOne<{ feedingTotalCount: string; feedingCompletedCount: string }>();

      return {
        mortalityCount: Number(mortalityRaw?.mortalityCount ?? 0),
        cullCount: Number(cullRaw?.cullCount ?? 0),
        wqReadingsCount,
        feedingCompletedCount: Number(feedingRaw?.feedingCompletedCount ?? 0),
        feedingTotalCount: Number(feedingRaw?.feedingTotalCount ?? 0),
      };
    });
  }

  /**
   * Resolve the single authoritative calendar day (YYYY-MM-DD) for the counts.
   * FARM-MEDIUM-056: a client-supplied strict YYYY-MM-DD becomes the boundary;
   * a malformed value falls back to the server timeZone computation.
   */
  private resolveCalendarDay(clientDate: string | undefined, timeZone: string): string {
    if (clientDate && this.isStrictIsoDate(clientDate)) {
      return clientDate;
    }
    return this.localDateString(new Date(), timeZone);
  }

  private localDateString(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private isStrictIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    return parsed.toISOString().slice(0, 10) === value;
  }
}
