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
 * so the aggregate can never diverge from the per-batch truth. The stock
 * handlers — allocate, mortality, cull, transfer, harvest and its reversal,
 * ledger reconcile — route through {@link applyStockChange}. `batchDetails[]` is
 * ALWAYS persisted (the historical `length > 1 ? details : undefined` discard is
 * the drift this fixes).
 *
 * NOT yet routed here, and therefore neither deriving through this writer nor
 * repricing the day: `create-batch.handler`'s bulk `initialLocations` path
 * (it builds and bulk-saves TankBatch rows itself) and the legacy
 * `BatchService.updateTankBatch*` primitives that recompute a tank from its
 * allocation ledger. Both predate this service; stocking a tank THROUGH batch
 * creation still bypasses the mechanism below.
 *
 * Concurrency: callers already hold a `pessimistic_write` lock on the TankBatch
 * row (consistent with transfer/mortality), so the read-modify-write below is
 * serialised per tank without needing SERIALIZABLE isolation.
 *
 * A COUNT CHANGE IS A RATION CHANGE — and it is not optional. Four of the five
 * stock paths remembered to reprice the day afterwards and `allocate-to-tank`
 * did not, so stocking a tank raised its biomass while the day's remaining meals
 * kept feeding the old, smaller number: fish underfed on their first day, with
 * nothing to warn anyone. Adding a fifth call site would only have left the sixth
 * writer free to forget again, so the write itself was made unreachable without
 * the recalculation: {@link applyBatchDelta} is PRIVATE and the only way to reach
 * it is {@link applyStockChange}, which settles every unit it touched — exactly
 * once each, in the caller's transaction, before it returns. Two additional paths
 * that had never recalculated at all (harvest reversal, ledger reconcile) became
 * correct by construction the moment they were routed through it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { TankBatch, BatchDetail } from '../entities/tank-batch.entity';
import { findTankOrEquipmentWithManager } from '../utils/tank-lookup.util';
import {
  StockChangeReason,
  UnitRationRecalculator,
  UNIT_RATION_RECALCULATOR,
} from './unit-ration-recalculator.port';

export interface TankBatchDelta {
  batchId: string;
  batchNumber: string;
  /** Signed change in fish count for this batch in this tank (+stock, -removal). */
  quantityDelta: number;
  /** Signed change in biomass (kg) for this batch in this tank. */
  biomassDelta: number;
  /** Optional new per-batch average weight (g); when omitted it is derived from biomass/quantity. */
  avgWeightG?: number;
  /** Optional last-mortality timestamp (mortality path) — stamped onto the row when present. */
  lastMortalityAt?: Date;
}

export interface TankMeta {
  code?: string;
  name?: string;
  /** Tank volume (m³) for density; 0/undefined → density 0. */
  volumeM3?: number;
}

/**
 * The stock-mutation handle handed to {@link TankBatchService.applyStockChange}.
 *
 * It cannot be constructed anywhere else: `applyStockChange` is the only producer
 * and the underlying writer is private to the service, so holding one of these is
 * the same thing as being inside a scope that will recalculate.
 */
export interface StockChange {
  /**
   * Apply one signed per-batch delta to one unit. May be called any number of
   * times, for any number of units — every touched unit is recalculated once
   * when the scope closes, never once per delta.
   */
  applyDelta(tankId: string, delta: TankBatchDelta, tankMeta?: TankMeta): Promise<TankBatch>;
}

@Injectable()
export class TankBatchService {
  constructor(
    @Inject(UNIT_RATION_RECALCULATOR)
    private readonly rationRecalculator: UnitRationRecalculator,
  ) {}

  /**
   * The ONLY way to change a unit's stock.
   *
   * Runs `work` with a {@link StockChange} handle, then — still inside the
   * caller's transaction — reprices today's remaining meals for every unit that
   * handle touched:
   *
   *  - EXACTLY ONCE per unit, no matter how many deltas landed on it (a caller
   *    that legitimately batches several deltas, e.g. a grading that moves two
   *    batches out of one tank, still produces one recalculation);
   *  - with the ACCUMULATED signed biomass delta, which is what moves the day's
   *    ration basis (see `ration-basis.ts`);
   *  - in ascending unitId order, so two transactions touching the same pair of
   *    units (a transfer and its mirror) can never take the day-plan locks in
   *    opposite orders;
   *  - AFTER every delta is written, so the recalculation reads settled stock;
   *  - only on success — a throwing `work` rolls the transaction back and there
   *    is nothing to reprice.
   *
   * Lock order is the canonical one (K-1): the caller already holds Batch →
   * TankBatch; the recalculation then takes DayPlan → Meals → Assignment.
   */
  async applyStockChange<T>(
    manager: EntityManager,
    tenantId: string,
    reason: StockChangeReason,
    work: (stock: StockChange) => Promise<T>,
  ): Promise<T> {
    const touchedUnits = new Map<string, number>();
    const stock: StockChange = {
      applyDelta: async (tankId, delta, tankMeta) => {
        const saved = await this.applyBatchDelta(manager, tenantId, tankId, delta, tankMeta);
        touchedUnits.set(tankId, (touchedUnits.get(tankId) ?? 0) + delta.biomassDelta);
        return saved;
      },
    };

    const result = await work(stock);

    const settlements = [...touchedUnits.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [unitId, stockBiomassDeltaKg] of settlements) {
      await this.rationRecalculator.recalcAfterStockChange(
        manager,
        tenantId,
        unitId,
        reason,
        stockBiomassDeltaKg,
      );
    }
    return result;
  }

  /**
   * Apply a signed per-batch delta to a tank's composition and persist it,
   * re-deriving every aggregate from `batchDetails[]`. Returns the saved row.
   *
   * PRIVATE ON PURPOSE — this is the writer that must never run without the
   * ration recalculation that follows it. Reach it through
   * {@link applyStockChange}; re-widening it (or reaching it from a second file)
   * fails `__tests__/services/tank-batch.service.spec.ts`.
   *
   * The caller MUST run this inside the tenant transaction (runInTenantTransaction)
   * and SHOULD pre-lock the TankBatch row (pessimistic_write) — this method also
   * locks defensively when it loads the row.
   */
  private async applyBatchDelta(
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
    // Self-heal pre-SSoT rows: a single-batch tank stocked before batchDetails[]
    // became the SSoT carries empty details but a populated total + primaryBatchId.
    // Reconstruct that single entry from the totals so a (negative) delta applies
    // to it, instead of being treated as "batch not present" (a silent no-op that
    // would skip mortality/cull/transfer on every pre-existing tank).
    if (details.length === 0 && Number(tankBatch.totalQuantity) > 0 && tankBatch.primaryBatchId) {
      const seededQty = Number(tankBatch.totalQuantity);
      const seededBiomass = Number(tankBatch.totalBiomassKg);
      details.push({
        batchId: tankBatch.primaryBatchId,
        batchNumber: tankBatch.primaryBatchNumber ?? '',
        quantity: seededQty,
        biomassKg: seededBiomass,
        avgWeightG: seededQty > 0 ? (seededBiomass * 1000) / seededQty : 0,
        percentageOfTank: 100,
      });
    }
    const idx = details.findIndex((d) => d.batchId === delta.batchId);

    if (idx >= 0) {
      const d = details[idx]!;
      // Per-tank availability is enforced HERE, in the single writer, so no
      // caller (mortality, cull, harvest, transfer, reconcile) can overdraw a
      // batch's share in THIS tank. Handlers validate only the batch-GLOBAL
      // count; the old Math.max clamp silently absorbed the difference (e.g.
      // 200 mortality against an 83-fish tank clamped to 0 and permanently
      // diverged batch vs tank aggregates). Overdraft is a domain error.
      if (delta.quantityDelta < 0 && -delta.quantityDelta > d.quantity) {
        throw new Error(
          `Batch ${delta.batchNumber || delta.batchId} has only ${d.quantity} fish in tank ` +
            `${tankMeta?.code ?? tankId}; cannot remove ${-delta.quantityDelta}`,
        );
      }
      d.quantity = d.quantity + delta.quantityDelta;
      // Math.max stays ONLY as a float-noise floor for biomass (kg arithmetic).
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
    } else if (delta.quantityDelta < 0) {
      // Removing from a batch that is not in this tank is an overdraft by
      // definition — the old silent no-op hid mis-attributed removals.
      throw new Error(
        `Batch ${delta.batchNumber || delta.batchId} has no fish in tank ` +
          `${tankMeta?.code ?? tankId}; cannot remove ${-delta.quantityDelta}`,
      );
    }

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

    // A1 mirror retirement (ORPHAN-HIGH-353 step 2): the currentQuantity COUNT
    // mirror is no longer written — every count read was collapsed onto the
    // batchDetails-derived totalQuantity SSoT (farm-tank-count-ssot.spec) and
    // DropTankBatchCurrentQuantityMirror removes the column. currentBiomassKg
    // deliberately REMAINS written: it is the growth-tracked live value
    // (daily-feeding-execution accrues weight-gain into it), re-baselined on
    // every batch delta until the separately-tracked biomass unification flows
    // growth into batchDetails.
    tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;
    if (delta.lastMortalityAt) {
      tankBatch.lastMortalityAt = delta.lastMortalityAt;
    }

    const saved = await manager.save(TankBatch, tankBatch);

    // SINGLE WRITER for the denormalized Tank/Equipment.currentCount column.
    // The web tenant panel reads equipmentList.currentCount while mobile reads
    // batchMetrics.pieces (← tank_batches). Historically each handler maintained
    // currentCount independently (compute-then-write), which drifted from
    // tank_batches (the SSoT) — the 900-vs-719 divergence. Derive currentCount
    // here from the just-computed totalQuantity so there is ONE count writer and
    // web + mobile can never diverge. COUNT-ONLY on purpose: currentBiomass is
    // left to its growth-tracking path (feeding weight-gain) — deriving it from
    // batchDetails-only totals would drop growth and under-report capacity
    // (unified separately once feeding growth flows into batchDetails).
    const lookup = await findTankOrEquipmentWithManager(manager, tankId, tenantId);
    if (lookup) {
      if (lookup.isFromTanksTable && lookup.originalTank) {
        await manager
          .createQueryBuilder()
          .update(Tank)
          .set({ currentCount: tankBatch.totalQuantity })
          .where('id = :id', { id: lookup.originalTank.id })
          .execute();
      } else {
        await manager
          .createQueryBuilder()
          .update(Equipment)
          .set({ currentCount: tankBatch.totalQuantity })
          .where('id = :id', { id: lookup.equipment.id })
          .execute();
      }
    }

    return saved;
  }
}
