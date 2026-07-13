/**
 * TankCountReconcileService — reconciliation of tank fish-COUNT drift.
 *
 * WHY: before the single-writer fix (FARM-HIGH-104) each handler maintained
 * equipment/tank.currentCount independently of tank_batches.totalQuantity, so the
 * two drifted (the operator saw 900 on mobile vs 719 on web for one tank). Going
 * forward applyBatchDelta keeps them in lock-step, but EXISTING rows can still
 * carry a wrong count, and pre-SSoT rows carry batchDetails=NULL while
 * totalQuantity has already converged. (The historical currentQuantity mirror is
 * fully retired — ORPHAN-HIGH-353; every count read is totalQuantity.) This
 * service recomputes each tank-batch's TRUE count from the operation ledger and
 * (only when applied) routes every correction — including the zero-delta
 * batchDetails seed for pre-SSoT rows — through applyBatchDelta, the single writer.
 *
 * LEDGER (verified against the write paths AND live data — FARM-HIGH-112):
 *   trueQty(tank,batch) =
 *       Σ tank_allocations.quantity  [initial_stocking | split | transfer_in | transfer_out]
 *     − Σ tank_operations.quantity   [mortality | cull | harvest], not deleted
 *   Allocation quantities are stored SIGNED — transfer-batch.handler writes the
 *   source row as `quantity: -payload.quantity` — so the allocation side is a
 *   plain SUM. (The first version re-negated transfer_out and double-counted;
 *   caught by the dry-run before any write.) Transfers live only in
 *   tank_allocations for this formula; mortality/cull/harvest only in
 *   tank_operations — every event counts exactly once.
 *
 * COMPLETENESS (fail-closed): a (tank,batch) whose ledger has NO inflow rows, or
 * whose net comes out negative, has an incomplete history (initial stocking via
 * createBatch predates the allocation-ledger write, FARM-HIGH-112). Such rows are
 * REPORTED with ledgerComplete=false and are NEVER auto-applied — a reconcile
 * from an incomplete ledger would corrupt a correct count.
 *
 * SAFETY: dryRun (default true) computes + returns the per-tank-batch diff WITHOUT
 * writing, so the operator reviews the recomputed values before applying. Apply
 * routes corrections through applyBatchDelta inside the tenant transaction
 * (fail-closed search_path + RLS).
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { DataSource, EntityManager } from 'typeorm';

import { TankBatch } from '../entities/tank-batch.entity';
import { TankBatchService } from './tank-batch.service';

@ObjectType()
export class TankCountReconcileRow {
  @Field(() => ID)
  tankId!: string;

  @Field(() => ID)
  batchId!: string;

  @Field()
  batchNumber!: string;

  /** Baseline count: batchDetails[batch].quantity, or totalQuantity for a pre-SSoT primary-batch row. */
  @Field(() => Int)
  currentQuantity!: number;

  /** The count recomputed from the operation ledger (signed allocations − removals). */
  @Field(() => Int)
  ledgerQuantity!: number;

  /** ledgerQuantity − currentQuantity (0 = already consistent). */
  @Field(() => Int)
  delta!: number;

  /** False when the ledger history is incomplete (no inflow rows / negative net) — such rows are never auto-applied. */
  @Field()
  ledgerComplete!: boolean;

  /** True when this row's count correction was written (apply mode, complete ledger, delta != 0). */
  @Field()
  applied!: boolean;

  /** True when a zero-delta self-heal was written (apply mode, delta 0, missing batchDetails). */
  @Field()
  healed!: boolean;
}

interface LedgerRow {
  tankId: string;
  batchId: string;
  trueQty: string; // numeric → string from pg
  inflowRows: string; // bigint → string from pg
}

const LEDGER_SQL = `
  WITH alloc AS (
    SELECT "tankId", "batchId",
      SUM(quantity) AS alloc_net,
      COUNT(*) FILTER (
        WHERE "allocationType" IN ('initial_stocking', 'split', 'transfer_in')
      ) AS inflow_rows
    FROM tank_allocations
    WHERE "tenantId" = $1
      AND ("isDeleted" IS NULL OR "isDeleted" = false)
      AND "allocationType" IN ('initial_stocking', 'split', 'transfer_in', 'transfer_out')
    GROUP BY "tankId", "batchId"
  ),
  ops AS (
    SELECT "tankId", "batchId", SUM(quantity) AS removed
    FROM tank_operations
    WHERE "tenantId" = $1
      AND ("isDeleted" IS NULL OR "isDeleted" = false)
      AND "operationType" IN ('mortality', 'cull', 'harvest')
    GROUP BY "tankId", "batchId"
  )
  SELECT a."tankId" AS "tankId", a."batchId" AS "batchId",
    a.alloc_net - COALESCE(o.removed, 0) AS "trueQty",
    a.inflow_rows AS "inflowRows"
  FROM alloc a
  LEFT JOIN ops o ON o."tankId" = a."tankId" AND o."batchId" = a."batchId"
`;

@Injectable()
export class TankCountReconcileService {
  private readonly logger = new Logger(TankCountReconcileService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tankBatchService: TankBatchService,
  ) {}

  /**
   * Recompute every tank-batch's true count from the ledger and (when
   * dryRun=false) correct drift / seed missing pre-SSoT batchDetails through
   * applyBatchDelta. Returns the per tank-batch diff either way.
   */
  async reconcile(
    tenantId: string,
    opts: { dryRun?: boolean; tankIds?: readonly string[] } = {},
  ): Promise<TankCountReconcileRow[]> {
    const dryRun = opts.dryRun ?? true;
    const tankFilter = opts.tankIds && opts.tankIds.length > 0 ? new Set(opts.tankIds) : null;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const ledger: LedgerRow[] = await manager.query(LEDGER_SQL, [tenantId]);
      const rows: TankCountReconcileRow[] = [];

      for (const entry of ledger) {
        if (tankFilter && !tankFilter.has(entry.tankId)) {
          continue;
        }
        const ledgerQuantity = Math.trunc(Number(entry.trueQty));
        const tankBatch = await manager.findOne(TankBatch, {
          where: { tenantId, tankId: entry.tankId },
        });
        const details = tankBatch?.batchDetails ?? [];
        const detail = details.find((d) => d.batchId === entry.batchId);
        const isPrimary = tankBatch?.primaryBatchId === entry.batchId;
        // Pre-SSoT rows carry batchDetails=NULL but a converged totalQuantity —
        // for the primary batch that total IS the baseline; reading 0 here made
        // the first version report phantom deltas on already-correct tanks.
        const currentQuantity =
          detail?.quantity ??
          (details.length === 0 && isPrimary ? Math.trunc(Number(tankBatch?.totalQuantity ?? 0)) : 0);
        const delta = ledgerQuantity - currentQuantity;
        // Fail-closed: no inflow history or a negative net = incomplete ledger
        // (e.g. initial stocking predates the createBatch allocation write).
        const ledgerComplete = Number(entry.inflowRows) > 0 && ledgerQuantity >= 0;
        // A pre-SSoT row still needs a zero-delta self-heal when batchDetails is
        // missing (seeds the per-batch SSoT from the correct totals). The old
        // stale-MIRROR heal condition is gone with the currentQuantity column
        // (A1 retirement, ORPHAN-HIGH-353 step 2) — every read is totalQuantity.
        const needsHeal = tankBatch != null && details.length === 0;

        let applied = false;
        let healed = false;
        if (!dryRun && ledgerComplete && tankBatch) {
          if (delta !== 0) {
            await this.applyCorrection(manager, tenantId, entry.tankId, {
              batchId: entry.batchId,
              batchNumber: detail?.batchNumber ?? tankBatch.primaryBatchNumber ?? '',
              delta,
              avgWeightG: detail?.avgWeightG ?? Number(tankBatch.avgWeightG ?? 0),
            });
            applied = true;
          } else if (needsHeal) {
            // Zero-delta write through the single writer: seeds batchDetails from
            // the (correct) totals and re-derives the aggregates + currentCount.
            await this.tankBatchService.applyBatchDelta(manager, tenantId, entry.tankId, {
              batchId: entry.batchId,
              batchNumber: detail?.batchNumber ?? tankBatch.primaryBatchNumber ?? '',
              quantityDelta: 0,
              biomassDelta: 0,
            });
            healed = true;
          }
        }

        rows.push({
          tankId: entry.tankId,
          batchId: entry.batchId,
          batchNumber: detail?.batchNumber ?? tankBatch?.primaryBatchNumber ?? '',
          currentQuantity,
          ledgerQuantity,
          delta,
          ledgerComplete,
          applied,
          healed,
        });
      }

      const drifted = rows.filter((r) => r.delta !== 0);
      const incomplete = rows.filter((r) => !r.ledgerComplete);
      this.logger.log(
        `[TankCountReconcile] tenant=${tenantId.substring(0, 8)} dryRun=${dryRun} ` +
          `scanned=${rows.length} drifted=${drifted.length} incomplete=${incomplete.length} ` +
          `applied=${rows.filter((r) => r.applied).length} healed=${rows.filter((r) => r.healed).length}`,
      );
      return rows;
    });
  }

  /**
   * Route one tank-batch's count correction through applyBatchDelta (the single
   * writer) so batchDetails[] + totalQuantity + currentCount all land on the
   * ledger truth. Biomass moves proportionally to the count so density stays
   * sane; the biomass SSoT itself is unified separately (growth model).
   */
  private async applyCorrection(
    manager: EntityManager,
    tenantId: string,
    tankId: string,
    correction: { batchId: string; batchNumber: string; delta: number; avgWeightG: number },
  ): Promise<void> {
    const biomassDelta = (correction.delta * correction.avgWeightG) / 1000;
    await this.tankBatchService.applyBatchDelta(manager, tenantId, tankId, {
      batchId: correction.batchId,
      batchNumber: correction.batchNumber,
      quantityDelta: correction.delta,
      biomassDelta,
    });
  }
}
