/**
 * GetMortalityByCauseQuery handler — fail-closed tenant boundary.
 *
 * Site scope resolves through the tank → department → site chain (the same
 * chain BiomassCalculatorService uses); species through batch → species.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';

import {
  GetMortalityByCauseQuery,
  MortalityByCauseResult,
} from '../queries/get-mortality-by-cause.query';

interface CauseRow {
  cause: string;
  count: string;
}

interface DetailRow {
  date: string;
  cause: string;
  speciesCode: string;
  count: string;
  biomassLossKg: string | null;
}

@QueryHandler(GetMortalityByCauseQuery)
export class GetMortalityByCauseHandler implements IQueryHandler<GetMortalityByCauseQuery> {
  async execute(query: GetMortalityByCauseQuery): Promise<MortalityByCauseResult> {
    const { scope, siteId, fromDate, toDate } = query;
    const tenantId = scope.tenantId;
    const siteScopeJoin = `
      JOIN tanks t ON t.id = mr."tankId" AND t."tenantId" = mr."tenantId"
      JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2`;
    const periodFilter = `mr."tenantId" = $1 AND mr."recordDate" BETWEEN $3 AND $4`;

    const causeRows: CauseRow[] = await scope.query(
      `SELECT mr.cause AS cause, SUM(mr.count)::bigint AS count
         FROM mortality_records mr
         ${siteScopeJoin}
        WHERE ${periodFilter}
        GROUP BY mr.cause
        ORDER BY count DESC`,
      [tenantId, siteId, fromDate, toDate],
    );

    const detailRows: DetailRow[] = await scope.query(
      `SELECT mr."recordDate"::text AS date,
              mr.cause AS cause,
              COALESCE(s."officialCode", s.code) AS "speciesCode",
              SUM(mr.count)::bigint AS count,
              SUM(mr."estimatedBiomassLoss")::numeric AS "biomassLossKg"
         FROM mortality_records mr
         ${siteScopeJoin}
         JOIN batches_v2 b ON b.id = mr."batchId" AND b."tenantId" = mr."tenantId"
         JOIN species s ON s.id = b."speciesId"
        WHERE ${periodFilter}
        GROUP BY mr."recordDate", mr.cause, s.code
        ORDER BY mr."recordDate"`,
      [tenantId, siteId, fromDate, toDate],
    );

    const recordCountRows: Array<{ recordCount: string }> = await scope.query(
      `SELECT COUNT(*)::bigint AS "recordCount"
         FROM mortality_records mr
         ${siteScopeJoin}
        WHERE ${periodFilter}`,
      [tenantId, siteId, fromDate, toDate],
    );

    const byCause = causeRows.map((row) => ({ cause: row.cause, count: Number(row.count) }));
    return {
      totalCount: byCause.reduce((sum, entry) => sum + entry.count, 0),
      byCause,
      details: detailRows.map((row) => ({
        date: row.date,
        cause: row.cause,
        speciesCode: row.speciesCode,
        count: Number(row.count),
        biomassLossKg: row.biomassLossKg == null ? undefined : Number(row.biomassLossKg),
      })),
      recordCount: Number(recordCountRows[0]?.recordCount ?? 0),
    };
  }
}
