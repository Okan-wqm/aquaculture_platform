/**
 * GetTransfersSummaryQuery handler — fail-closed tenant boundary.
 *
 * A TRANSFER_OUT from a tank in the site counts only when the destination
 * tank sits in a DIFFERENT site (or is unknown); mirrored for TRANSFER_IN
 * and the source tank. Same-site moves are internal and excluded.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  GetTransfersSummaryQuery,
  TransfersSummaryResult,
  TransferSummaryRecord,
} from '../queries/get-transfers-summary.query';

interface TransferRow {
  date: string;
  direction: 'IN' | 'OUT';
  speciesCode: string;
  fishCount: string;
  biomassKg: string | null;
  counterparty: string | null;
}

@QueryHandler(GetTransfersSummaryQuery)
export class GetTransfersSummaryHandler implements IQueryHandler<GetTransfersSummaryQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetTransfersSummaryQuery): Promise<TransfersSummaryResult> {
    const { tenantId, siteId, fromDate, toDate } = query;
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const rows: TransferRow[] = await queryRunner.query(
        `WITH tank_sites AS (
           SELECT t.id AS tank_id, d."siteId" AS site_id, st.name AS site_name
             FROM tanks t
             JOIN departments d ON d.id = t."departmentId"
             LEFT JOIN sites st ON st.id = d."siteId"
            WHERE t."tenantId" = $1
         )
         SELECT o."operationDate"::date::text AS date,
                CASE WHEN o."operationType" = 'transfer_out' THEN 'OUT' ELSE 'IN' END AS direction,
                COALESCE(s."officialCode", s.code) AS "speciesCode",
                SUM(o.quantity)::bigint AS "fishCount",
                SUM(o."biomassKg")::numeric AS "biomassKg",
                other_side.site_name AS counterparty
           FROM tank_operations o
           JOIN tank_sites own ON own.tank_id = o."tankId" AND own.site_id = $2
           LEFT JOIN tank_sites other_side ON other_side.tank_id = CASE
                  WHEN o."operationType" = 'transfer_out' THEN o."destinationTankId"
                  ELSE o."sourceTankId"
                END
           JOIN batches_v2 b ON b.id = o."batchId" AND b."tenantId" = o."tenantId"
           JOIN species s ON s.id = b."speciesId"
          WHERE o."tenantId" = $1
            AND o."operationType" IN ('transfer_out', 'transfer_in')
            AND o."operationDate"::date BETWEEN $3 AND $4
            AND (other_side.site_id IS NULL OR other_side.site_id <> $2)
          GROUP BY o."operationDate"::date, direction, s.code, other_side.site_name
          ORDER BY o."operationDate"::date`,
        [tenantId, siteId, fromDate, toDate],
      );

      const recordCountRows: Array<{ recordCount: string }> = await queryRunner.query(
        `WITH tank_sites AS (
           SELECT t.id AS tank_id, d."siteId" AS site_id
             FROM tanks t
             JOIN departments d ON d.id = t."departmentId"
            WHERE t."tenantId" = $1
         )
         SELECT COUNT(*)::bigint AS "recordCount"
           FROM tank_operations o
           JOIN tank_sites own ON own.tank_id = o."tankId" AND own.site_id = $2
           LEFT JOIN tank_sites other_side ON other_side.tank_id = CASE
                  WHEN o."operationType" = 'transfer_out' THEN o."destinationTankId"
                  ELSE o."sourceTankId"
                END
          WHERE o."tenantId" = $1
            AND o."operationType" IN ('transfer_out', 'transfer_in')
            AND o."operationDate"::date BETWEEN $3 AND $4
            AND (other_side.site_id IS NULL OR other_side.site_id <> $2)`,
        [tenantId, siteId, fromDate, toDate],
      );

      const records: TransferSummaryRecord[] = rows.map((row) => ({
        date: row.date,
        direction: row.direction,
        speciesCode: row.speciesCode,
        fishCount: Number(row.fishCount),
        biomassKg: row.biomassKg == null ? 0 : Number(row.biomassKg),
        counterparty: row.counterparty ?? undefined,
      }));
      return { records, recordCount: Number(recordCountRows[0]?.recordCount ?? 0) };
    });
  }
}
