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
 * Concurrency: this service owns one canonical identity fence for every unit,
 * including units without a TankBatch row, followed by ordered
 * `pessimistic_write` tuple locks. Callers receive only a callback-scoped
 * capability; they cannot select a payload-dependent lock order.
 */
import { Injectable } from '@nestjs/common';
import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import { EntityManager, In } from 'typeorm';

import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { TankBatch, BatchDetail } from '../entities/tank-batch.entity';
import { findTankOrEquipmentWithManager } from '../utils/tank-lookup.util';
import { BatchAggregateMutationPort } from '../batch-aggregate-mutation.port';
import type { TankBatchTransitionIntentV1 } from '../batch-aggregate-mutation.port';

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
  /** Closed durable mutation intent; generic callers use stock_delta_applied. */
  transitionIntent?: TankBatchTransitionIntentV1;
}

export interface TankCapacityProjectionV1 {
  readonly isOverCapacity: boolean;
  readonly utilizationPercent: number;
}

export interface TankMeta {
  code?: string;
  name?: string;
  /** Tank volume (m³) for density; 0/undefined → density 0. */
  volumeM3?: number;
  /** CapacityService-derived projection persisted in the same aggregate commit. */
  capacity?: TankCapacityProjectionV1;
}

const TANK_BATCH_MUTATION_SET_BRAND: unique symbol = Symbol();

export interface TankBatchMutationSnapshotV1 {
  readonly tankId: string;
  readonly primaryBatchId?: string;
  readonly totalQuantity: number;
  readonly totalBiomassKg: number;
  readonly avgWeightG: number;
  readonly densityKgM3: number;
  readonly cleanerFishBiomassKg: number;
  readonly batchDetails: readonly Readonly<BatchDetail>[];
}

/** Callback-scoped capability over one canonically locked unit set. */
export interface TankBatchMutationSetV1 {
  readonly [TANK_BATCH_MUTATION_SET_BRAND]: true;
  readonly unitIds: readonly string[];
  snapshot(unitId: string): TankBatchMutationSnapshotV1 | null;
  applyBatchDelta(
    unitId: string,
    delta: TankBatchDelta,
    tankMeta?: TankMeta,
  ): Promise<TankBatch>;
}

function canonicalUnitIds(unitIds: readonly string[]): readonly string[] {
  if (unitIds.length === 0) throw new Error('TankBatch mutation set cannot be empty');
  if (unitIds.some((unitId) => unitId.length === 0 || unitId !== unitId.trim())) {
    throw new Error('TankBatch mutation unitId must be a non-empty canonical identifier');
  }
  const canonical = [...unitIds].sort();
  if (new Set(canonical).size !== canonical.length) {
    throw new Error('TankBatch mutation set cannot contain duplicate units');
  }
  return Object.freeze(canonical);
}

function snapshotOf(tankBatch: TankBatch): TankBatchMutationSnapshotV1 {
  return Object.freeze({
    tankId: tankBatch.tankId,
    primaryBatchId: tankBatch.primaryBatchId,
    totalQuantity: Number(tankBatch.totalQuantity),
    totalBiomassKg: Number(tankBatch.totalBiomassKg),
    avgWeightG: Number(tankBatch.avgWeightG),
    densityKgM3: Number(tankBatch.densityKgM3),
    cleanerFishBiomassKg: Number(tankBatch.cleanerFishBiomassKg ?? 0),
    batchDetails: Object.freeze(
      (tankBatch.batchDetails ?? []).map((detail) => Object.freeze({ ...detail })),
    ),
  });
}

@Injectable()
export class TankBatchService {
  constructor(private readonly batchMutations: BatchAggregateMutationPort) {}

  /**
   * Acquires one exact multi-unit lock set in `tankId ASC` order.
   *
   * Every identity first receives the same transaction advisory lock in sorted
   * order, regardless of whether its aggregate exists. Existing rows are then
   * selected and tuple-locked in one ordered statement. One lock namespace thus
   * serializes existing-row mutations and concurrent first stock without an
   * existence-dependent ordering branch. The only mutation surface is the
   * callback-scoped capability and it is invalid after callback return.
   */
  async withLockedTankBatchSet<T>(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    unitIds: readonly string[],
    work: (scope: TankBatchMutationSetV1) => Promise<T>,
  ): Promise<T> {
    const canonicalIds = canonicalUnitIds(unitIds);
    for (const unitId of canonicalIds) {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `tank-batch-mutation/v1:${tenantId}:${unitId}`,
      ]);
    }
    const lockedRows = await manager.find(TankBatch, {
      where: { tenantId, tankId: In([...canonicalIds]) },
      order: { tankId: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const lockedIds = lockedRows.map((row) => row.tankId);
    const canonicalLockedIds = [...lockedIds].sort();
    if (lockedIds.some((unitId, index) => unitId !== canonicalLockedIds[index])) {
      throw new Error('TankBatch lock query did not preserve canonical unit order');
    }
    const byUnitId = new Map<string, TankBatch>();
    for (const row of lockedRows) {
      if (
        row.tenantId !== tenantId ||
        !canonicalIds.includes(row.tankId) ||
        byUnitId.has(row.tankId)
      ) {
        throw new Error('TankBatch lock query returned an invalid unit set');
      }
      byUnitId.set(row.tankId, row);
    }
    let active = true;
    const assertActiveUnit = (unitId: string): void => {
      if (!active) throw new Error('TankBatch mutation set cannot outlive its lock callback');
      if (!canonicalIds.includes(unitId)) {
        throw new Error(`TankBatch mutation set does not own unit ${unitId}`);
      }
    };
    const scope = Object.freeze({
      [TANK_BATCH_MUTATION_SET_BRAND]: true,
      unitIds: canonicalIds,
      snapshot: (unitId: string) => {
        assertActiveUnit(unitId);
        const aggregate = byUnitId.get(unitId);
        return aggregate ? snapshotOf(aggregate) : null;
      },
      applyBatchDelta: async (unitId: string, delta: TankBatchDelta, tankMeta?: TankMeta) => {
        assertActiveUnit(unitId);
        const saved = await this.applyLockedBatchDelta(
          manager,
          mutationSession,
          tenantId,
          unitId,
          byUnitId.get(unitId) ?? null,
          delta,
          tankMeta,
        );
        byUnitId.set(unitId, saved);
        return saved;
      },
    } satisfies TankBatchMutationSetV1);
    try {
      return await work(scope);
    } finally {
      active = false;
    }
  }

  /**
   * Apply a signed per-batch delta to a tank's composition and persist it,
   * re-deriving every aggregate from `batchDetails[]`. Returns the saved row.
   *
   * The caller MUST run this inside the tenant transaction
   * (runInTenantTransaction). Lock acquisition is entirely owned by
   * `withLockedTankBatchSet`; callers must not pre-lock TankBatch rows.
   */
  async applyBatchDelta(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    tankId: string,
    delta: TankBatchDelta,
    tankMeta?: TankMeta,
  ): Promise<TankBatch> {
    return this.withLockedTankBatchSet(
      manager,
      mutationSession,
      tenantId,
      [tankId],
      (scope) => scope.applyBatchDelta(tankId, delta, tankMeta),
    );
  }

  private async applyLockedBatchDelta(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    tankId: string,
    lockedTankBatch: TankBatch | null,
    delta: TankBatchDelta,
    tankMeta?: TankMeta,
  ): Promise<TankBatch> {
    let tankBatch = lockedTankBatch;

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
          (delta.quantityDelta > 0
            ? (Math.max(0, delta.biomassDelta) * 1000) / delta.quantityDelta
            : 0),
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
      d.percentageOfTank =
        tankBatch.totalQuantity > 0 ? (d.quantity / tankBatch.totalQuantity) * 100 : 0;
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
    if (tankMeta?.capacity) {
      if (
        !Number.isFinite(tankMeta.capacity.utilizationPercent) ||
        tankMeta.capacity.utilizationPercent < 0
      ) {
        throw new Error('Tank capacity utilization must be a non-negative finite number');
      }
      tankBatch.isOverCapacity = tankMeta.capacity.isOverCapacity;
      tankBatch.capacityUsedPercent = tankMeta.capacity.utilizationPercent;
    }

    const saved = await this.batchMutations.commitTankBatchTransition(mutationSession, {
      intent: delta.transitionIntent ?? 'stock_delta_applied',
      aggregate: tankBatch,
    });

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
        await this.batchMutations.replaceTankCountProjection(mutationSession, {
          tankId: lookup.originalTank.id,
          currentCount: tankBatch.totalQuantity,
        });
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
