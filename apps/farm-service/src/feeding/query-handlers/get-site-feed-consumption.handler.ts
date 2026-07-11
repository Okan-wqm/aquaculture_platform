/**
 * GetSiteFeedConsumptionQuery handler — fail-closed tenant boundary.
 *
 * Sums feeding_records.actualAmount per feed type for all tanks under the
 * site (tank → department → site chain), replacing the frontend's old
 * "daily plan × 30" guess with the real fed-amount ledger.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  GetSiteFeedConsumptionQuery,
  SiteFeedConsumptionResult,
} from '../queries/get-site-feed-consumption.query';

interface FeedTypeRow {
  feedName: string;
  brandName: string | null;
  quantityKg: string;
  recordCount: string;
}

@QueryHandler(GetSiteFeedConsumptionQuery)
export class GetSiteFeedConsumptionHandler implements IQueryHandler<GetSiteFeedConsumptionQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetSiteFeedConsumptionQuery): Promise<SiteFeedConsumptionResult> {
    const { tenantId, siteId, fromDate, toDate } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rows: FeedTypeRow[] = await queryRunner.query(
        `SELECT f.name AS "feedName",
                f.brand AS "brandName",
                SUM(fr."actualAmount")::numeric AS "quantityKg",
                COUNT(*)::bigint AS "recordCount"
           FROM feeding_records fr
           JOIN tanks t ON t.id = fr."tankId" AND t."tenantId" = fr."tenantId"
           JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2
           JOIN feeds f ON f.id = fr."feedId"
          WHERE fr."tenantId" = $1
            AND fr."feedingDate"::date BETWEEN $3 AND $4
          GROUP BY f.name, f.brand
          ORDER BY "quantityKg" DESC`,
        [tenantId, siteId, fromDate, toDate],
      );

      const byFeedType = rows.map((row) => ({
        feedName: row.feedName,
        brandName: row.brandName ?? undefined,
        quantityKg: Number(row.quantityKg),
      }));
      return {
        totalKg: byFeedType.reduce((sum, entry) => sum + entry.quantityKg, 0),
        byFeedType,
        recordCount: rows.reduce((sum, row) => sum + Number(row.recordCount), 0),
      };
    });
  }
}
