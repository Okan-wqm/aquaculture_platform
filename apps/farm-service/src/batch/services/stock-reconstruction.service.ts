/**
 * StockReconstructionService (FARM-HIGH-182) — point-in-time standing stock.
 *
 * The live biomass path (BiomassCalculatorService.getSiteBiomassReport) reads
 * `batches_v2.currentQuantity` attributed to a site by CURRENT `tank_batches`
 * occupancy, faithful only for the current / just-closed period. A regulatory
 * biomass report for a materially historical month needs the standing stock AS
 * IT WAS at that month-end — reconstructed from source records.
 *
 * REPLAY AXIS — PER (site tank, batch), NOT per batch. An earlier per-batch draft
 * attributed a batch's GLOBAL count to every site it ever touched, which
 * double-counted a batch transferred across sites and pulled cleaner-fish into
 * the production beholdning (re-review FARM-HIGH-001/002). Fish live in a TANK;
 * the tank belongs to a site; so the standing stock at a site is the sum over its
 * tanks of what each tank holds at T:
 *
 *   qty(tank, batch, T) =
 *       Σ tank_allocations.quantity  [initial_stocking|split|transfer_in|transfer_out]  (SIGNED, allocationDate ≤ T)
 *     − Σ mortality_records.count             (recordDate  ≤ T, this tank)
 *     − Σ tank_operations.quantity CULL       (operationDate ≤ T, not deleted, this tank)
 *     − Σ harvest_records.quantityHarvested   (harvestDate  ≤ T, status ≠ cancelled, this tank)
 *
 * This is the TankCountReconcileService.LEDGER_SQL formula (verified against live
 * data, FARM-HIGH-112) with a `≤ T` filter, EXCEPT harvest is sourced from
 * harvest_records filtered `status ≠ cancelled` rather than the un-reversed
 * `tank_operations('harvest')` mirror (FARM-HIGH-198). A transfer moves fish
 * between tanks via the signed allocation legs, so a batch that left a site nets
 * to zero there and appears only at its destination site — counted once.
 *
 * SCOPE — production only. Cleaner-fish stock is not in `tank_allocations` (its
 * moves are `cleaner_*` operations / `cleanerFishDetails`) and its removals are
 * `cleaner_*` op types, so the production allocation + `mortality|cull|harvest`
 * removal set excludes it structurally; a `batchType = 'production'` filter makes
 * that explicit.
 *
 * DOUBLE-COUNT AVOIDANCE: mortality and harvest each double-write a
 * `tank_operations` mirror in the same transaction. Each physical event is
 * replayed from EXACTLY ONE ledger — mortality from mortality_records, harvest
 * from harvest_records, cull from tank_operations (its only home) — never the
 * mirror; transfers only from tank_allocations. Every event counts once.
 *
 * FAIL-CLOSED: only a provably-complete replay yields a RECORDS number. A
 * (tank, batch) with no positive-inflow allocation row (initial stocking predates
 * the allocation ledger, FARM-HIGH-112), a negative net (a ledger gap), an
 * un-attributable removal (a mortality/harvest row with NULL tankId that cannot
 * be placed on a tank), or stock with no recorded weight at T → `complete=false`
 * and the caller keeps its blocking MANUAL_REQUIRED. A wrong regulatory number is
 * worse than an honest "verify manually".
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

/** One (tank, batch) pair's replay inputs at the period end, from the ledgers. */
interface TankBatchReconstructionRow {
  tankId: string;
  batchId: string;
  speciesId: string;
  speciesName: string;
  speciesCode: string;
  // All numeric aggregates are ::text-cast in SQL so they arrive as strings;
  // `fold` coerces with Number(...) and guards NULL weight with `== null`.
  inflowSigned: string;
  /** Count of positive-inflow allocation rows (initial_stocking|split|transfer_in). */
  inflowRows: string;
  mortality: string;
  cull: string;
  harvest: string;
  /** Removals for this batch that carry a NULL tankId and cannot be placed on a tank. */
  unattributableRemovals: string;
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
 * Per-(site tank, batch) replay SQL ($1 tenantId, $2 siteId, $3 periodEndDate).
 * Exported so the CI Postgres integration spec runs the EXACT query the service
 * runs — no drift between a hand-copied test query and production.
 *
 * A (tank, batch) pair is in scope when it has ANY production allocation or
 * mortality/cull/harvest removal on a site tank up to T (so a batch whose initial
 * stocking predates the allocation ledger still surfaces — and fails closed on
 * inflowRows=0 rather than being silently dropped). Inflows come from signed
 * `tank_allocations`; removals from the single SSoT per event type
 * (mortality_records, tank_operations CULL, harvest_records status≠cancelled),
 * scoped to the tank. `unattributableRemovals` counts this batch's mortality /
 * harvest rows with a NULL tankId — they cannot be placed on a tank, so the fold
 * fails the batch closed rather than silently ignoring a removal.
 */
export const BATCH_RECONSTRUCTION_SQL = `WITH site_tanks AS (
    SELECT t.id AS tank_id
      FROM tanks t
      JOIN departments d ON d.id = t."departmentId"
     WHERE t."tenantId" = $1 AND d."siteId" = $2
  ),
  alloc AS (
    SELECT ta."tankId" AS tank_id, ta."batchId" AS batch_id,
           SUM(ta.quantity) AS inflow_signed,
           COUNT(*) FILTER (
             WHERE ta."allocationType" IN ('initial_stocking', 'split', 'transfer_in')
           ) AS inflow_rows
      FROM tank_allocations ta
      JOIN site_tanks st ON st.tank_id = ta."tankId"
     WHERE ta."tenantId" = $1
       AND (ta."isDeleted" IS NULL OR ta."isDeleted" = false)
       AND ta."allocationType" IN ('initial_stocking', 'split', 'transfer_in', 'transfer_out')
       AND ta."allocationDate"::date <= $3
     GROUP BY ta."tankId", ta."batchId"
  ),
  mort AS (
    SELECT mr."tankId" AS tank_id, mr."batchId" AS batch_id, COALESCE(SUM(mr.count), 0) AS removed
      FROM mortality_records mr
      JOIN site_tanks st ON st.tank_id = mr."tankId"
     WHERE mr."tenantId" = $1 AND mr."recordDate"::date <= $3
     GROUP BY mr."tankId", mr."batchId"
  ),
  cull AS (
    SELECT o."tankId" AS tank_id, o."batchId" AS batch_id, COALESCE(SUM(o.quantity), 0) AS removed
      FROM tank_operations o
      JOIN site_tanks st ON st.tank_id = o."tankId"
     WHERE o."tenantId" = $1
       AND o."operationType" = 'cull'
       AND (o."isDeleted" IS NULL OR o."isDeleted" = false)
       AND o."operationDate"::date <= $3
     GROUP BY o."tankId", o."batchId"
  ),
  harv AS (
    SELECT hr."tankId" AS tank_id, hr."batchId" AS batch_id,
           COALESCE(SUM(hr."quantityHarvested"), 0) AS removed
      FROM harvest_records hr
      JOIN site_tanks st ON st.tank_id = hr."tankId"
     WHERE hr."tenantId" = $1
       AND hr."harvestDate"::date <= $3
       AND hr.status <> 'cancelled'
     GROUP BY hr."tankId", hr."batchId"
  ),
  unattr AS (
    -- Mortality / harvest rows for a batch that carry NO tankId: they cannot be
    -- apportioned to a tank, so any resident row of that batch fails closed.
    SELECT batch_id, SUM(n) AS n FROM (
      SELECT mr."batchId" AS batch_id, COUNT(*) AS n
        FROM mortality_records mr
       WHERE mr."tenantId" = $1 AND mr."recordDate"::date <= $3 AND mr."tankId" IS NULL
       GROUP BY mr."batchId"
      UNION ALL
      SELECT hr."batchId" AS batch_id, COUNT(*) AS n
        FROM harvest_records hr
       WHERE hr."tenantId" = $1 AND hr."harvestDate"::date <= $3
         AND hr.status <> 'cancelled' AND hr."tankId" IS NULL
       GROUP BY hr."batchId"
    ) u
    GROUP BY batch_id
  ),
  resident AS (
    -- FARM-MEDIUM-210: a production batch currently resident in a site tank,
    -- stocked by T, but carrying NO tank_allocations at all (a pre-FARM-HIGH-112
    -- stocking that predates the allocation ledger) would otherwise never enter
    -- 'pairs' — a silent omission that could file a wrong "0 kg" for a site whose
    -- only stock is such a batch. Surfacing it here routes it through the
    -- inflowRows=0 guard so the whole site fails closed instead. A batch that
    -- arrived after T has a transfer_in allocation, so it is excluded here.
    SELECT DISTINCT st.tank_id AS tank_id, b.id AS batch_id
      FROM tank_batches tb
      JOIN site_tanks st ON st.tank_id = tb."tankId"
      JOIN batches_v2 b
        ON b."batchType" = 'production'
       AND b."tenantId" = $1
       AND b."stockedAt"::date <= $3
       AND (
         tb."primaryBatchId" = b.id
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) bd
            WHERE bd->>'batchId' = b.id::text
         )
       )
     WHERE tb."tenantId" = $1
       AND NOT EXISTS (
         SELECT 1 FROM tank_allocations ta WHERE ta."tenantId" = $1 AND ta."batchId" = b.id
       )
  ),
  pairs AS (
    SELECT tank_id, batch_id FROM alloc
    UNION SELECT tank_id, batch_id FROM mort
    UNION SELECT tank_id, batch_id FROM cull
    UNION SELECT tank_id, batch_id FROM harv
    UNION SELECT tank_id, batch_id FROM resident
  ),
  latest_meas AS (
    -- FARM-LOW-199: measurementDate is day-granular, so two same-day samplings
    -- tie on it. createdAt (timestamptz) breaks the tie by true recency and id
    -- makes it fully deterministic, so the picked weight — and thus the reported
    -- biomass — is reproducible across replicas / after a VACUUM.
    SELECT DISTINCT ON (m."batchId") m."batchId" AS batch_id, m."averageWeight" AS avg_w
      FROM growth_measurements m
     WHERE m."tenantId" = $1 AND m."measurementDate"::date <= $3
     ORDER BY m."batchId", m."measurementDate" DESC, m."createdAt" DESC, m.id DESC
  )
  SELECT p.tank_id AS "tankId",
         p.batch_id AS "batchId",
         b."speciesId" AS "speciesId",
         s.name AS "speciesName",
         COALESCE(s."officialCode", s.code) AS "speciesCode",
         COALESCE(a.inflow_signed, 0)::text AS "inflowSigned",
         COALESCE(a.inflow_rows, 0)::text AS "inflowRows",
         COALESCE(mort.removed, 0)::text AS mortality,
         COALESCE(cull.removed, 0)::text AS cull,
         COALESCE(harv.removed, 0)::text AS harvest,
         COALESCE(un.n, 0)::text AS "unattributableRemovals",
         COALESCE(lm.avg_w, (b.weight->'initial'->>'avgWeight')::numeric)::text AS "avgWeightG"
    FROM pairs p
    JOIN batches_v2 b ON b.id = p.batch_id AND b."batchType" = 'production'
    JOIN species s ON s.id = b."speciesId"
    LEFT JOIN alloc a ON a.tank_id = p.tank_id AND a.batch_id = p.batch_id
    LEFT JOIN mort ON mort.tank_id = p.tank_id AND mort.batch_id = p.batch_id
    LEFT JOIN cull ON cull.tank_id = p.tank_id AND cull.batch_id = p.batch_id
    LEFT JOIN harv ON harv.tank_id = p.tank_id AND harv.batch_id = p.batch_id
    LEFT JOIN unattr un ON un.batch_id = p.batch_id
    LEFT JOIN latest_meas lm ON lm.batch_id = p.batch_id
   ORDER BY p.tank_id, p.batch_id`;

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
   * Fold per-(tank, batch) ledger rows into a site total, fail-closed. A pair that
   * nets to 0 is genuinely emptied by the period end (transferred / harvested /
   * culled out) and is skipped, NOT a gap. A pair with no positive-inflow
   * allocation row, a negative net, an un-attributable (NULL-tank) removal on its
   * batch, or stock without a recorded weight aborts the whole reconstruction —
   * the caller then keeps its blocking MANUAL_REQUIRED. Quantities are summed per
   * SPECIES across the site's tank/batch pairs.
   */
  static fold(rows: TankBatchReconstructionRow[]): ReconstructedSiteStock {
    const empty: ReconstructedSiteStock = {
      complete: false,
      totalQuantity: 0,
      totalBiomassKg: 0,
      batchCount: 0,
      speciesBreakdown: [],
    };

    const bySpecies = new Map<string, SpeciesAccumulator>();
    const batchesInStock = new Set<string>();

    for (const row of rows) {
      if (Number(row.unattributableRemovals) > 0) {
        return {
          ...empty,
          incompleteReason: `batch ${row.batchId} has a mortality/harvest record with no tank — it cannot be attributed to a site tank`,
        };
      }
      if (Number(row.inflowRows) === 0) {
        return {
          ...empty,
          incompleteReason: `batch ${row.batchId} has no stocking/transfer-in allocation into tank ${row.tankId} — its inflow ledger is incomplete for this period`,
        };
      }
      const qty =
        Number(row.inflowSigned) -
        Number(row.mortality) -
        Number(row.cull) -
        Number(row.harvest);
      if (qty < 0) {
        return {
          ...empty,
          incompleteReason: `tank ${row.tankId} / batch ${row.batchId} reconstructs to a negative quantity (${qty}) — the source ledger is incomplete for this period`,
        };
      }
      if (qty === 0) {
        // Emptied by the period end (all fish removed or transferred out) — not a gap.
        continue;
      }
      const avgWeightG = row.avgWeightG == null ? null : Number(row.avgWeightG);
      if (avgWeightG == null || avgWeightG <= 0) {
        return {
          ...empty,
          incompleteReason: `batch ${row.batchId} held ${qty} fish in tank ${row.tankId} at the period end but has no recorded weight then`,
        };
      }

      batchesInStock.add(row.batchId);
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
      batchCount: batchesInStock.size,
      speciesBreakdown,
    };
  }

  /** Per-(site tank, batch) replay inputs at the period end. See class docblock. */
  private async queryBatchReconstruction(
    qr: QueryRunner,
    tenantId: string,
    siteId: string,
    periodEndDate: string,
  ): Promise<TankBatchReconstructionRow[]> {
    return qr.query(BATCH_RECONSTRUCTION_SQL, [tenantId, siteId, periodEndDate]);
  }
}
