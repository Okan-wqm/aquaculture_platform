/**
 * GetMortalityDailyHistoryQuery handler — fail-closed tenant boundary.
 *
 * One GROUP BY over mortality_records (tenantId, recordDate); the per-day
 * totals feed the health page's 14-day mortality chart.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  GetMortalityDailyHistoryQuery,
  MortalityDailyPoint,
} from '../queries/get-mortality-daily-history.query';

interface DailyRow {
  date: string;
  count: string;
}

@QueryHandler(GetMortalityDailyHistoryQuery)
export class GetMortalityDailyHistoryHandler
  implements IQueryHandler<GetMortalityDailyHistoryQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetMortalityDailyHistoryQuery): Promise<MortalityDailyPoint[]> {
    const { tenantId, days } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rows: DailyRow[] = await queryRunner.query(
        `SELECT mr."recordDate"::text AS date,
                SUM(mr.count)::bigint AS count
           FROM mortality_records mr
          WHERE mr."tenantId" = $1
            AND mr."recordDate" >= (CURRENT_DATE - ($2::int - 1))
          GROUP BY mr."recordDate"
          ORDER BY mr."recordDate"`,
        [tenantId, days],
      );

      return rows.map((row) => ({ date: row.date, count: Number(row.count) }));
    });
  }
}
