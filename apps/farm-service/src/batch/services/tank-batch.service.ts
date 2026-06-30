/**
 * TankBatchService — single source of truth for a tank's batch composition.
 *
 * WHY: a tank's stock was mutated by THREE divergent code paths — allocate
 * (kept `batchDetails[]` + derived aggregates, but dropped batchDetails for
 * single-batch tanks), and a hand-written `updateTankBatchWithManager`
 * duplicated in transfer-batch.handler AND batch.service (delta on
 * `totalQuantity` only, never touching `batchDetails[]`). In a mixed-batch tank
 * the per-batch breakdown silently drifted from the aggregate.
 *
 * WHAT: `batchDetails[]` is the SSoT. `totalQuantity` / `totalBiomassKg` /
 * `avgWeightG` / `densityKgM3` / `percentageOfTank` are ALWAYS derived from it,
 * so the aggregate can never diverge from the per-batch truth. Every handler
 * that changes a tank's stock (allocate, mortality, cull, transfer, createBatch)
 * routes through {@link applyBatchDelta}; the two duplicate primitives delegate
 * here. `batchDetails[]` is ALWAYS persisted (the historical
 * `length > 1 ? details : undefined` discard is the drift this fixes).
 *
 * Concurrency: callers already hold a `pessimistic_write` lock on the TankBatch
 * row (consistent with transfer/mortality), so the read-modify-write below is
 * serialised per tank without needing SERIALIZABLE isolation.
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { TankBatch, BatchDetail } from '../entities/tank-batch.entity';

export interface TankBatchDelta {
  batchId: string;
  batchNumber: string;
  /** Signed change in fish count for this batch in this tank (+stock, -removal). */
  quantityDelta: number;
  /** Signed change in biomass (kg) for this batch in this tank. */
  biomassDelta: number;
  /** Optional new per-batch average weight (g); when omitted it is derived from biomass/quantity. */
  avgWeightG?: number;
}

export interface TankMeta {
  code?: string;
  name?: string;
  /** Tank volume (m³) for density; 0/undefined → density 0. */
  volumeM3?: number;
}

@Injectable()
export class TankBatchService {
  /**
   * Apply a signed per-batch delta to a tank's composition and persist it,
   * re-deriving every aggregate from `batchDetails[]`. Returns the saved row.
   *
   * The caller MUST run this inside the tenant transaction (runInTenantTransaction)
   * and SHOULD pre-lock the TankBatch row (pessimistic_write) — this method also
   * locks defensively when it loads the row.
   */
  async applyBatchDelta(
    manager: EntityManager,
    tenantId: string,
    tankId: string,
    delta: TankBatchDelta,
    tankMeta?: TankMeta,
  ): Promise<TankBatch> {
    let tankBatch = await manager.findOne(TankBatch, {
      where: { tenantId, tankId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!tankBatch) {
      tankBatch = manager.create(TankBatch, {
        tenantId,
        tankId,
        tankCode: tankMeta?.code,
        tankName: tankMeta?.name,
        totalQuantity: 0,
        totalBiomassKg: 0,
        avgWeightG: 0,
        densityKgM3: 0,
        isMixedBatch: false,
        isOverCapacity: false,
        cleanerFishBiomassKg: 0,
        cleanerFishQuantity: 0,
        batchDetails: [],
      });
    } else if (tankMeta?.code) {
      // Keep denormalized tank identity fresh without a second write path.
      tankBatch.tankCode = tankMeta.code;
      tankBatch.tankName = tankMeta.name;
    }

    const details: BatchDetail[] = tankBatch.batchDetails ?? [];
    const idx = details.findIndex((d) => d.batchId === delta.batchId);

    if (idx >= 0) {
      const d = details[idx]!;
      d.quantity = Math.max(0, d.quantity + delta.quantityDelta);
      d.biomassKg = Math.max(0, d.biomassKg + delta.biomassDelta);
      if (delta.avgWeightG != null) {
        d.avgWeightG = delta.avgWeightG;
      } else if (d.quantity > 0) {
        d.avgWeightG = (d.biomassKg * 1000) / d.quantity;
      }
      // A batch that drops to zero in this tank leaves the composition.
      if (d.quantity <= 0) {
        details.splice(idx, 1);
      }
    } else if (delta.quantityDelta > 0) {
      details.push({
        batchId: delta.batchId,
        batchNumber: delta.batchNumber,
        quantity: delta.quantityDelta,
        biomassKg: Math.max(0, delta.biomassDelta),
        avgWeightG:
          delta.avgWeightG ??
          (delta.quantityDelta > 0 ? (Math.max(0, delta.biomassDelta) * 1000) / delta.quantityDelta : 0),
        percentageOfTank: 0,
      });
    }
    // A negative delta for a batch not present is a no-op (nothing to remove).

    // ── Derive every aggregate from the SSoT (batchDetails[]) ──
    tankBatch.totalQuantity = details.reduce((sum, d) => sum + d.quantity, 0);
    tankBatch.totalBiomassKg = details.reduce((sum, d) => sum + d.biomassKg, 0);
    tankBatch.avgWeightG =
      tankBatch.totalQuantity > 0 ? (tankBatch.totalBiomassKg * 1000) / tankBatch.totalQuantity : 0;
    const volume = tankMeta?.volumeM3 ?? 0;
    tankBatch.densityKgM3 = volume ? tankBatch.totalBiomassKg / volume : 0;
    for (const d of details) {
      d.percentageOfTank = tankBatch.totalQuantity > 0 ? (d.quantity / tankBatch.totalQuantity) * 100 : 0;
    }

    tankBatch.isMixedBatch = details.length > 1;
    // ALWAYS persist batchDetails[] (the SSoT) — including single-batch and
    // emptied tanks — so no downstream read or mutation loses the per-batch truth.
    tankBatch.batchDetails = details;
    tankBatch.primaryBatchId = details[0]?.batchId;
    tankBatch.primaryBatchNumber = details[0]?.batchNumber;

    return manager.save(TankBatch, tankBatch);
  }
}
