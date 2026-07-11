/**
 * Biomass (FD-0001) report assembler — the server-side source of the
 * monthly biomass draft.
 *
 * Dedup verdict RPT-012: BiomassCalculatorService.getSiteBiomassReport is
 * THE standing-stock source (species-aware, N+1-free); the frontend's
 * client-side tank math is deleted in the same phase. Every section is
 * aggregated from operational SSoTs:
 *
 *   currentBiomass  → BiomassCalculatorService (batches + tank allocations)
 *   stockings       → batches_v2.stockedAt / initialQuantity (+ supplier)
 *   mortality       → GetMortalityByCauseQuery (mortality_records GROUP BY cause)
 *   slaughter       → harvest_records for the period
 *   transfers       → GetTransfersSummaryQuery (cross-site tank_operations)
 *   feedConsumption → GetSiteFeedConsumptionQuery (feeding_records ledger)
 *
 * The operator reviews and approves; corrections flow to the source
 * records, never into a forked report copy.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryBus } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { BiomassCalculatorService } from '../../batch/services/biomass-calculator.service';
import {
  GetMortalityByCauseQuery,
  MortalityByCauseResult,
} from '../../batch/queries/get-mortality-by-cause.query';
import {
  GetTransfersSummaryQuery,
  TransfersSummaryResult,
} from '../../batch/queries/get-transfers-summary.query';
import {
  GetSiteFeedConsumptionQuery,
  SiteFeedConsumptionResult,
} from '../../feeding/queries/get-site-feed-consumption.query';
import { BiomassReportPayload } from '../entities/biomass-report.entity';
import { AssembledDraft, fromRecords, manualRequired } from './provenance.types';
import { isStandingStockStale, monthRange, round2 } from './period.util';

interface StockingRow {
  date: string;
  speciesCode: string;
  supplier: string | null;
  fishCount: string;
  avgWeightG: string | null;
  batchNumber: string;
}

interface SlaughterRow {
  date: string;
  speciesCode: string;
  quantity: string;
  biomassKg: string | null;
  buyer: string | null;
}

@Injectable()
export class BiomassReportAssembler {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBus: QueryBus,
    private readonly biomassCalculator: BiomassCalculatorService,
  ) {}

  async assemble(
    tenantId: string,
    siteId: string,
    reportYear: number,
    reportMonth: number,
  ): Promise<AssembledDraft<BiomassReportPayload>> {
    const { fromDate, toDate } = monthRange(reportYear, reportMonth);

    const [siteBiomass, mortality, transfers, feed, stockingRows, slaughterRows] =
      await Promise.all([
        this.biomassCalculator.getSiteBiomassReport(siteId, tenantId),
        this.queryBus.execute<GetMortalityByCauseQuery, MortalityByCauseResult>(
          new GetMortalityByCauseQuery(tenantId, siteId, fromDate, toDate),
        ),
        this.queryBus.execute<GetTransfersSummaryQuery, TransfersSummaryResult>(
          new GetTransfersSummaryQuery(tenantId, siteId, fromDate, toDate),
        ),
        this.queryBus.execute<GetSiteFeedConsumptionQuery, SiteFeedConsumptionResult>(
          new GetSiteFeedConsumptionQuery(tenantId, siteId, fromDate, toDate),
        ),
        this.queryStockings(tenantId, siteId, fromDate, toDate),
        this.querySlaughter(tenantId, siteId, fromDate, toDate),
      ]);

    const draftPayload: BiomassReportPayload = {
      currentBiomass: {
        totalKg: round2(siteBiomass.totalBiomassKg),
        bySpecies: siteBiomass.speciesBreakdown.map((entry) => ({
          speciesId: entry.speciesId,
          speciesName: entry.speciesName,
          fishCount: entry.quantity,
          biomassKg: round2(entry.biomassKg),
          avgWeightG: entry.quantity > 0 ? round2((entry.biomassKg * 1000) / entry.quantity) : 0,
        })),
      },
      stockings: stockingRows.map((row) => {
        const fishCount = Number(row.fishCount);
        const avgWeightG = row.avgWeightG == null ? 0 : Number(row.avgWeightG);
        return {
          date: row.date,
          speciesCode: row.speciesCode,
          supplier: row.supplier ?? undefined,
          fishCount,
          avgWeightG: round2(avgWeightG),
          biomassKg: round2((fishCount * avgWeightG) / 1000),
          notes: row.batchNumber,
        };
      }),
      mortality: {
        totalCount: mortality.totalCount,
        byCause: mortality.byCause,
        details: mortality.details.map((detail) => ({
          date: detail.date,
          cause: detail.cause,
          speciesCode: detail.speciesCode,
          count: detail.count,
          biomassLossKg: detail.biomassLossKg,
        })),
      },
      slaughter: {
        totalQuantity: slaughterRows.reduce((sum, row) => sum + Number(row.quantity), 0),
        totalBiomassKg: round2(
          slaughterRows.reduce((sum, row) => sum + Number(row.biomassKg ?? 0), 0),
        ),
        records: slaughterRows.map((row) => ({
          date: row.date,
          speciesCode: row.speciesCode,
          quantity: Number(row.quantity),
          biomassKg: row.biomassKg == null ? 0 : round2(Number(row.biomassKg)),
          buyer: row.buyer ?? undefined,
        })),
      },
      transfers: transfers.records.map((record) => ({
        date: record.date,
        direction: record.direction,
        speciesCode: record.speciesCode,
        fishCount: record.fishCount,
        biomassKg: round2(record.biomassKg),
        counterparty: record.counterparty,
      })),
      feedConsumption: {
        totalKg: round2(feed.totalKg),
        byFeedType: feed.byFeedType.map((entry) => ({
          feedName: entry.feedName,
          brandName: entry.brandName,
          quantityKg: round2(entry.quantityKg),
        })),
      },
    };

    // FARM-HIGH-005: the standing stock is the CURRENT live inventory. For the
    // current/just-closed period that is a faithful proxy for the closing
    // beholdning and stays RECORDS. For a materially historical period the live
    // stock no longer reflects that month-end, so we must NOT stamp today's
    // number as RECORDS — fail closed to a blocking MANUAL_REQUIRED so the
    // operator supplies the real period-end figure and auto-submit cannot file
    // a stale number. (Deeper fix — a point-in-time stock ledger that
    // reconstructs the exact month-end beholdning — is tracked as
    // FARM-HIGH-182.)
    const currentBiomassMeta = isStandingStockStale(toDate, new Date())
      ? manualRequired(
          '/currentBiomass',
          `Standing stock is assembled from the CURRENT live inventory, which no longer ` +
            `reflects the ${reportYear}-${String(reportMonth).padStart(2, '0')} month-end ` +
            `(the period closed over a month ago). Verify and enter the actual closing ` +
            `beholdning for the period.`,
          true,
        )
      : fromRecords(
          '/currentBiomass',
          'BiomassCalculatorService.getSiteBiomassReport',
          siteBiomass.batchCount,
        );

    const fields = [
      currentBiomassMeta,
      fromRecords('/stockings', 'BiomassReportAssembler.queryStockings', stockingRows.length),
      fromRecords('/mortality', 'GetMortalityByCauseQuery', mortality.recordCount),
      fromRecords('/slaughter', 'BiomassReportAssembler.querySlaughter', slaughterRows.length),
      fromRecords('/transfers', 'GetTransfersSummaryQuery', transfers.recordCount),
      fromRecords('/feedConsumption', 'GetSiteFeedConsumptionQuery', feed.recordCount),
    ];
    // FD-0001 accepts an all-sourced report; nothing here is schema-blocking.
    // Sections without period activity legitimately assemble empty — flag the
    // feed ledger explicitly because an empty month there usually means the
    // feeding module is not in use, not that no feed was consumed.
    if (feed.recordCount === 0) {
      fields.push(
        manualRequired(
          '/feedConsumption',
          `No feeding records found for ${fromDate}..${toDate} — enter feed use manually or record feedings.`,
          false,
        ),
      );
    }

    return { draftPayload, fields };
  }

  private async queryStockings(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<StockingRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // A batch counts as stocked into the site when any tank allocation
      // (primary or combined-batch detail) points at a tank under the site.
      return queryRunner.query(
        `SELECT DISTINCT b."stockedAt"::date::text AS date,
                COALESCE(s."officialCode", s.code) AS "speciesCode",
                b."supplierBatchNumber" AS supplier,
                b."initialQuantity"::bigint AS "fishCount",
                (b.weight->'initial'->>'avgWeight')::numeric AS "avgWeightG",
                b."batchNumber" AS "batchNumber"
           FROM batches_v2 b
           JOIN species s ON s.id = b."speciesId"
          WHERE b."tenantId" = $1
            AND b."stockedAt"::date BETWEEN $3 AND $4
            AND (
              EXISTS (
                SELECT 1 FROM tank_batches tb
                JOIN tanks t ON t.id = tb."tankId"
                JOIN departments d ON d.id = t."departmentId"
                WHERE tb."tenantId" = b."tenantId"
                  AND tb."primaryBatchId" = b.id
                  AND d."siteId" = $2
              )
              OR EXISTS (
                SELECT 1 FROM tank_batches tb
                JOIN tanks t ON t.id = tb."tankId"
                JOIN departments d ON d.id = t."departmentId",
                jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) AS bd
                WHERE tb."tenantId" = b."tenantId"
                  AND d."siteId" = $2
                  AND bd->>'batchId' = b.id::text
              )
            )
          ORDER BY date`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }

  private async querySlaughter(
    tenantId: string,
    siteId: string,
    fromDate: string,
    toDate: string,
  ): Promise<SlaughterRow[]> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      return queryRunner.query(
        `SELECT hr."harvestDate"::date::text AS date,
                COALESCE(s."officialCode", s.code) AS "speciesCode",
                SUM(hr."quantityHarvested")::bigint AS quantity,
                SUM(hr."totalBiomass")::numeric AS "biomassKg",
                NULL::text AS buyer
           FROM harvest_records hr
           JOIN tanks t ON t.id = hr."tankId" AND t."tenantId" = hr."tenantId"
           JOIN departments d ON d.id = t."departmentId" AND d."siteId" = $2
           JOIN batches_v2 b ON b.id = hr."batchId" AND b."tenantId" = hr."tenantId"
           JOIN species s ON s.id = b."speciesId"
          WHERE hr."tenantId" = $1
            AND hr."harvestDate"::date BETWEEN $3 AND $4
          GROUP BY hr."harvestDate"::date, s.code, s."officialCode"
          ORDER BY date`,
        [tenantId, siteId, fromDate, toDate],
      );
    });
  }
}
