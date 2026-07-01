/**
 * TankCountReconcileService — one-time reconciliation of tank fish-COUNT drift.
 *
 * WHY: before the single-writer fix (FARM-HIGH-104) each handler maintained
 * equipment/tank.currentCount independently of tank_batches.totalQuantity, so the
 * two drifted (the operator saw 900 on mobile vs 719 on web for one tank). Going
 * forward applyBatchDelta keeps them in lock-step, but EXISTING rows are still
 * off. This service recomputes each tank-batch's TRUE count from the operation
 * ledger — the auditable source, not either drifted denormalization — and (only
 * when applied) routes the correction through applyBatchDelta, the single writer,
 * so batchDetails[] + totalQuantity + currentCount all land on the ledger truth.
 *
 * LEDGER (no double-count — verified against the write paths):
 *   trueQty(tank,batch) =
 *       Σ tank_allocations.quantity  [initial_stocking | split | transfer_in]
 *     − Σ tank_allocations.quantity  [transfer_out]
 *     − Σ tank_operations.quantity   [mortality | cull | harvest], isDeleted=false
 *   Transfers live in tank_allocations (in/out); mortality/cull/harvest live only
 *   in tank_operations — so summing allocations for transfers and operations for
 *   removals counts every event exactly once.
 *
 * SAFETY: dryRun (default true) computes + returns the per-tank-batch diff WITHOUT
 * writing, so the operator reviews the recomputed values before applying. Apply
 * routes every non-zero delta through applyBatchDelta inside the tenant
 * transaction (fail-closed search_path + RLS).
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

  /** Current tank_batches.batchDetails[batch].quantity. */
  @Field(() => Int)
  currentQuantity!: number;

  /** The count recomputed from the operation ledger (allocations − removals). */
  @Field(() => Int)
  ledgerQuantity!: number;

  /** ledgerQuantity − currentQuantity (0 = already consistent). */
  @Field(() => Int)
  delta!: number;

  /** True when this row's correction was written (apply mode + delta != 0). */
  @Field()
  applied!: boolean;
}

interface LedgerRow {
  tankId: string;
  batchId: string;
  trueQty: string; // numeric → string from pg
}

const LEDGER_SQL = `
  WITH alloc AS (
    SELECT "tankId", "batchId",
      SUM(CASE
        WHEN "allocationType" IN ('initial_stocking', 'split', 'transfer_in') THEN quantity
        WHEN "allocationType" = 'transfer_out' THEN -quantity
        ELSE 0 END) AS alloc_net
    FROM tank_allocations
    WHERE "tenantId" = $1
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
    GREATEST(0, a.alloc_net - COALESCE(o.removed, 0)) AS "trueQty"
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
   * dryRun=false) correct the drift through applyBatchDelta. Returns the per
   * tank-batch diff either way.
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
        const detail = tankBatch?.batchDetails?.find((d) => d.batchId === entry.batchId);
        const currentQuantity = detail?.quantity ?? 0;
        const delta = ledgerQuantity - currentQuantity;

        let applied = false;
        if (!dryRun && delta !== 0) {
          await this.applyCorrection(manager, tenantId, entry.tankId, {
            batchId: entry.batchId,
            batchNumber: detail?.batchNumber ?? tankBatch?.primaryBatchNumber ?? '',
            delta,
            avgWeightG: detail?.avgWeightG ?? 0,
          });
          applied = true;
        }

        rows.push({
          tankId: entry.tankId,
          batchId: entry.batchId,
          batchNumber: detail?.batchNumber ?? '',
          currentQuantity,
          ledgerQuantity,
          delta,
          applied,
        });
      }

      const drifted = rows.filter((r) => r.delta !== 0);
      this.logger.log(
        `[TankCountReconcile] tenant=${tenantId.substring(0, 8)} dryRun=${dryRun} ` +
          `scanned=${rows.length} drifted=${drifted.length} ` +
          `applied=${rows.filter((r) => r.applied).length}`,
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
