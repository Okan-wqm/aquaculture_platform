/**
 * StockReconstructionService (FARM-HIGH-182) — point-in-time standing stock.
 *
 * The live biomass path (BiomassCalculatorService.getSiteBiomassReport) reads
 * `batches_v2.currentQuantity`, which is only faithful for the current /
 * just-closed period. A regulatory biomass report for a materially historical
 * month needs the standing stock AS IT WAS at that month-end — reconstructed
 * from source records, not approximated by today's inventory.
 *
 * REPLAY RECIPE (per-BATCH axis — mirrors `batches_v2.currentQuantity`
 * semantics exactly, so a reconstructed period-end number is computed the SAME
 * way the live report computes the current number, just as-of a past date):
 *
 *   qty(batch, T) = initialQuantity
 *                 − Σ mortality_records.count          (recordDate  ≤ T)
 *                 − Σ tank_operations.quantity CULL     (operationDate ≤ T, not deleted)
 *                 − Σ harvest_records.quantityHarvested (harvestDate ≤ T, status ≠ cancelled)
 *
 * DOUBLE-COUNT AVOIDANCE (the core hazard): mortality and harvest each write TWO
 * tables in one transaction (mortality_records + tank_operations('mortality');
 * harvest_records + tank_operations('harvest')). Each physical event is replayed
 * from EXACTLY ONE ledger — mortality from mortality_records, harvest from
 * harvest_records, cull from tank_operations (its only home) — never summing the
 * mirror. Transfers are batch-internal (the live handler leaves currentQuantity
 * unchanged on transfer), so they are ignored at the batch axis. Harvest is
 * filtered `status ≠ cancelled` because a cancelled harvest reverses the live
 * mirror but leaves its tank_operations mirror row un-reversed. This is the exact
 * split TankCountReconcileService verified against live data (FARM-HIGH-112).
 *
 * FAIL-CLOSED: reconstruction is only trustworthy when every in-stock batch has a
 * known baseline and weight and never replays negative. If a batch has no
 * initial quantity, reconstructs below zero (a ledger gap), or has stock but no
 * recorded weight at T, `complete=false` and the caller keeps its MANUAL_REQUIRED
 * fallback — a wrong regulatory number is worse than an honest "verify manually".
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

export interface ReconstructedSpeciesStock {
  speciesId: string;
  speciesName: string;
  speciesCode: string;
  quantity: number;
  biomassKg: number;
  avgWeightG: number;
}

export interface ReconstructedSiteStock {
  /** True only when every in-stock batch reconstructed cleanly (see fail-closed). */
  complete: boolean;
  /** Populated when complete=false — the first batch/reason that broke the replay. */
  incompleteReason?: string;
  totalQuantity: number;
  totalBiomassKg: number;
  /** Number of batches that still held stock (qty > 0) at the period end. */
  batchCount: number;
  speciesBreakdown: ReconstructedSpeciesStock[];
}

/** One batch's replay inputs at the period end, straight from the ledgers. */
interface BatchReconstructionRow {
  batchId: string;
  speciesId: string;
  speciesName: string;
  speciesCode: string;
  // int4 comes back from node-postgres as a JS number; the removal SUMs and the
  // weight are ::text-cast in SQL so they arrive as strings. `fold` handles both
  // via `== null` + `Number(...)`.
  initialQuantity: number | string | null;
  mortality: string;
  cull: string;
  harvest: string;
  avgWeightG: string | null;
}

interface SpeciesAccumulator {
  speciesId: string;
  speciesName: string;
  speciesCode: string;
  quantity: number;
  biomassKg: number;
}

/**
 * Per-batch replay SQL ($1 tenantId, $2 siteId, $3 periodEndDate). Exported so
 * the CI Postgres integration spec runs the EXACT query the service runs — no
 * drift between a hand-copied test query and production. Membership is the union
 * of current tank_batches occupancy (live parity) and any historical inflow /
 * operation on a site tank up to T, so a batch present at the site then but now
 * closed is still counted. Removals come from the single SSoT per event type
 * (mortality_records, tank_operations CULL, harvest_records status≠cancelled).
 */
export const BATCH_RECONSTRUCTION_SQL = `WITH site_tanks AS (
    SELECT t.id AS tank_id
      FROM tanks t
      JOIN departments d ON d.id = t."departmentId"
     WHERE t."tenantId" = $1 AND d."siteId" = $2
  ),
  site_batches AS (
    SELECT b.id AS batch_id
      FROM batches_v2 b
     WHERE b."tenantId" = $1
       AND b."stockedAt"::date <= $3
       AND (
         EXISTS (
           SELECT 1 FROM tank_batches tb
           JOIN site_tanks st ON st.tank_id = tb."tankId"
           WHERE tb."tenantId" = b."tenantId"
             AND (
               tb."primaryBatchId" = b.id
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) bd
                  WHERE bd->>'batchId' = b.id::text
               )
             )
         )
         OR EXISTS (
           SELECT 1 FROM tank_allocations ta
           JOIN site_tanks st ON st.tank_id = ta."tankId"
           WHERE ta."tenantId" = b."tenantId"
             AND ta."batchId" = b.id
             AND ta."allocationType" IN ('initial_stocking', 'split', 'transfer_in')
             AND ta."allocationDate"::date <= $3
         )
         OR EXISTS (
           SELECT 1 FROM tank_operations o
           JOIN site_tanks st ON st.tank_id = o."tankId"
           WHERE o."tenantId" = b."tenantId"
             AND o."batchId" = b.id
             AND o."operationDate"::date <= $3
         )
       )
  ),
  mort AS (
    SELECT mr."batchId" AS batch_id, COALESCE(SUM(mr.count), 0) AS removed
      FROM mortality_records mr
     WHERE mr."tenantId" = $1 AND mr."recordDate"::date <= $3
     GROUP BY mr."batchId"
  ),
  cull AS (
    SELECT o."batchId" AS batch_id, COALESCE(SUM(o.quantity), 0) AS removed
      FROM tank_operations o
     WHERE o."tenantId" = $1
       AND o."operationType" = 'cull'
       AND (o."isDeleted" IS NULL OR o."isDeleted" = false)
       AND o."operationDate"::date <= $3
     GROUP BY o."batchId"
  ),
  harv AS (
    SELECT hr."batchId" AS batch_id, COALESCE(SUM(hr."quantityHarvested"), 0) AS removed
      FROM harvest_records hr
     WHERE hr."tenantId" = $1
       AND hr."harvestDate"::date <= $3
       AND hr.status <> 'cancelled'
     GROUP BY hr."batchId"
  ),
  latest_meas AS (
    -- DATA-LOW-001: measurementDate is day-granular, so two same-day samplings
    -- tie on it. createdAt (timestamptz) breaks the tie by true recency and id
    -- makes it fully deterministic, so the picked weight — and thus the reported
    -- biomass — is reproducible across replicas / after a VACUUM.
    SELECT DISTINCT ON (m."batchId") m."batchId" AS batch_id, m."averageWeight" AS avg_w
      FROM growth_measurements m
     WHERE m."tenantId" = $1 AND m."measurementDate"::date <= $3
     ORDER BY m."batchId", m."measurementDate" DESC, m."createdAt" DESC, m.id DESC
  )
  SELECT b.id AS "batchId",
         b."speciesId" AS "speciesId",
         s.name AS "speciesName",
         COALESCE(s."officialCode", s.code) AS "speciesCode",
         b."initialQuantity" AS "initialQuantity",
         COALESCE(mort.removed, 0)::text AS mortality,
         COALESCE(cull.removed, 0)::text AS cull,
         COALESCE(harv.removed, 0)::text AS harvest,
         COALESCE(lm.avg_w, (b.weight->'initial'->>'avgWeight')::numeric)::text AS "avgWeightG"
    FROM site_batches sb
    JOIN batches_v2 b ON b.id = sb.batch_id
    JOIN species s ON s.id = b."speciesId"
    LEFT JOIN mort ON mort.batch_id = b.id
    LEFT JOIN cull ON cull.batch_id = b.id
    LEFT JOIN harv ON harv.batch_id = b.id
    LEFT JOIN latest_meas lm ON lm.batch_id = b.id
   ORDER BY b.id`;

@Injectable()
export class StockReconstructionService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Reconstruct the site's standing stock at the given period-end date (inclusive,
   * `YYYY-MM-DD` — all four ledgers store day-granular dates). Pure read; a fresh
   * fail-closed tenant boundary. The folding (fail-closed guards + species
   * aggregation) is delegated to the pure static `fold` so it is unit-testable
   * without a database.
   */
  async reconstructSiteStockAtPeriodEnd(
    tenantId: string,
    siteId: string,
    periodEndDate: string,
  ): Promise<ReconstructedSiteStock> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (qr) => {
      const rows = await this.queryBatchReconstruction(qr, tenantId, siteId, periodEndDate);
      return StockReconstructionService.fold(rows);
    });
  }

  /**
   * Fold per-batch ledger rows into a site total, fail-closed. A batch that
   * reconstructs to 0 is genuinely emptied by the period end (harvested/culled
   * out) and is skipped, NOT treated as a gap. A missing baseline, a negative
   * reconstruction, or stock without a weight aborts the whole reconstruction.
   */
  static fold(rows: BatchReconstructionRow[]): ReconstructedSiteStock {
    const empty: ReconstructedSiteStock = {
      complete: false,
      totalQuantity: 0,
      totalBiomassKg: 0,
      batchCount: 0,
      speciesBreakdown: [],
    };

    const bySpecies = new Map<string, SpeciesAccumulator>();
    let batchCount = 0;

    for (const row of rows) {
      if (row.initialQuantity == null) {
        return { ...empty, incompleteReason: `batch ${row.batchId} has no recorded initial quantity` };
      }
      const qty =
        Number(row.initialQuantity) -
        Number(row.mortality) -
        Number(row.cull) -
        Number(row.harvest);
      if (qty < 0) {
        return {
          ...empty,
          incompleteReason: `batch ${row.batchId} reconstructs to a negative quantity (${qty}) — the source ledger is incomplete for this period`,
        };
      }
      if (qty === 0) {
        // Fully removed by the period end — correctly out of stock, not a gap.
        continue;
      }
      const avgWeightG = row.avgWeightG == null ? null : Number(row.avgWeightG);
      if (avgWeightG == null || avgWeightG <= 0) {
        return {
          ...empty,
          incompleteReason: `batch ${row.batchId} held ${qty} fish at the period end but has no recorded weight then`,
        };
      }

      batchCount += 1;
      const acc = bySpecies.get(row.speciesId) ?? {
        speciesId: row.speciesId,
        speciesName: row.speciesName,
        speciesCode: row.speciesCode,
        quantity: 0,
        biomassKg: 0,
      };
      acc.quantity += qty;
      acc.biomassKg += (qty * avgWeightG) / 1000;
      bySpecies.set(row.speciesId, acc);
    }

    const speciesBreakdown: ReconstructedSpeciesStock[] = Array.from(bySpecies.values()).map(
      (acc) => ({
        speciesId: acc.speciesId,
        speciesName: acc.speciesName,
        speciesCode: acc.speciesCode,
        quantity: acc.quantity,
        biomassKg: Math.round(acc.biomassKg * 100) / 100,
        avgWeightG: acc.quantity > 0 ? Math.round((acc.biomassKg * 1000) / acc.quantity * 100) / 100 : 0,
      }),
    );

    return {
      complete: true,
      totalQuantity: speciesBreakdown.reduce((sum, s) => sum + s.quantity, 0),
      totalBiomassKg: Math.round(speciesBreakdown.reduce((sum, s) => sum + s.biomassKg, 0) * 100) / 100,
      batchCount,
      speciesBreakdown,
    };
  }

  /**
   * Per-batch replay inputs for every batch that was present at the site by the
   * period end. Membership is the union of current tank_batches occupancy (live
   * parity) and any historical inflow/operation on a site tank up to T — so a
   * batch that was at the site then but is now closed/removed is still counted.
   * Removals come from the single SSoT per event type (see class docblock).
   */
  private async queryBatchReconstruction(
    qr: QueryRunner,
    tenantId: string,
    siteId: string,
    periodEndDate: string,
  ): Promise<BatchReconstructionRow[]> {
    return qr.query(BATCH_RECONSTRUCTION_SQL, [tenantId, siteId, periodEndDate]);
  }
}
