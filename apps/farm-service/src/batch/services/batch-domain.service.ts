import { BadRequestException, Injectable } from '@nestjs/common';

import {
  Batch,
  BatchStatus,
  BatchType,
  OPERATIONAL_BATCH_STATUSES,
} from '../entities/batch.entity';

import { BatchLifecyclePolicyService } from './batch-lifecycle-policy.service';

/**
 * IP-3: Batch domain logic — extracted from batch.entity.ts.
 *
 * WHY: Entity classes should hold data (columns, relations) not business logic.
 * Putting calculations in the entity violates SRP and prevents unit testing
 * without instantiating a full TypeORM entity. This service is stateless
 * and can be injected anywhere batch calculations are needed.
 *
 * All methods accept a Batch (or partial) and return computed values.
 * No database access — pure domain logic.
 */
@Injectable()
export class BatchDomainService {
  constructor(
    private readonly lifecyclePolicy: BatchLifecyclePolicyService = new BatchLifecyclePolicyService(),
  ) {}


  // ── Biomass & Weight ──────────────────────────────────────────────────────

  /**
   * Current biomass in kg, DERIVED from the live count.
   *
   * WHY: avgWeight changes only at a sampling event; currentQuantity is
   * atomically decremented under pessimistic_write by every removal handler
   * (mortality, cull, harvest). Deriving qty × avgWeight makes it structurally
   * impossible for the displayed biomass to drift from the live count — the
   * previously-stored weight.actual.totalBiomass snapshot went stale the moment
   * any removal happened, overstating biomass (and therefore understating FCR).
   * WHAT: kg = currentQuantity × effectiveAvgWeightG / 1000.
   */
  getCurrentBiomass(batch: Batch): number {
    const avgWeightG = this.getCurrentAvgWeight(batch);
    return (batch.currentQuantity * avgWeightG) / 1000;
  }

  /**
   * Current average weight per individual in grams.
   * Priority: actual → theoretical → initial.
   */
  getCurrentAvgWeight(batch: Batch): number {
    if (batch.weight?.actual?.avgWeight) {
      return batch.weight.actual.avgWeight;
    }
    if (batch.weight?.theoretical?.avgWeight) {
      return batch.weight.theoretical.avgWeight;
    }
    return batch.weight?.initial?.avgWeight || 0;
  }

  // ── Mortality & Survival ──────────────────────────────────────────────────

  /**
   * Mortality rate as percentage of initial quantity.
   * Only counts natural deaths — cull removals are excluded.
   */
  getMortalityRate(batch: Batch): number {
    if (batch.initialQuantity <= 0) return 0;
    return (batch.totalMortality / batch.initialQuantity) * 100;
  }

  /**
   * Survival rate = 100% - mortality rate.
   * Excludes culled fish (only natural mortality).
   */
  getSurvivalRate(batch: Batch): number {
    if (batch.initialQuantity <= 0) return 100;
    return ((batch.initialQuantity - batch.totalMortality) / batch.initialQuantity) * 100;
  }

  /**
   * Retention rate — includes both mortality AND cull removals.
   * retention = (currentQuantity / initialQuantity) × 100
   */
  getRetentionRate(batch: Batch): number {
    if (batch.initialQuantity <= 0) return 100;
    return (batch.currentQuantity / batch.initialQuantity) * 100;
  }

  // ── Performance Metrics ───────────────────────────────────────────────────

  // FCR authority removed from the domain service (Tier-1 one-SSoT
  // consolidation). The single FCR calculator is
  // FcrCalculationService.calculateCumulativeFCR, which reads net-exited
  // biomass from the TankOperation ledger. The naive `current − initial +
  // mortalityBiomass` weight-gain formula that lived here overstated FCR by
  // undercounting the growth of biomass that left the system via cull /
  // harvest / transfer-out, masking herd-health degradation.

  /**
   * Specific Growth Rate (SGR) — daily percentage body weight gain.
   * SGR = ((ln(finalWeight) - ln(initialWeight)) / days) × 100
   *
   * Typical range: 0.5-3.0 %/day depending on species and temperature.
   */
  calculateSGR(batch: Batch): number {
    const initialWeight = batch.weight?.initial?.avgWeight || 0;
    const currentWeight = this.getCurrentAvgWeight(batch);
    const days = this.getDaysInProduction(batch);

    if (initialWeight <= 0 || currentWeight <= 0 || days <= 0) return 0;
    return ((Math.log(currentWeight) - Math.log(initialWeight)) / days) * 100;
  }

  /**
   * Number of days since stocking date.
   * Uses actual harvest date as end point if batch has been harvested.
   */
  getDaysInProduction(batch: Batch): number {
    const stockDate = new Date(batch.stockedAt);
    const endDate = batch.actualHarvestDate
      ? new Date(batch.actualHarvestDate)
      : new Date();
    const diffTime = Math.abs(endDate.getTime() - stockDate.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  // ── Status & Classification ───────────────────────────────────────────────

  /**
   * Validate whether a status transition is allowed.
   *
   * State machine:
   *   QUARANTINE → ACTIVE, FAILED
   *   ACTIVE → GROWING, TRANSFERRED, FAILED
   *   GROWING → PRE_HARVEST, TRANSFERRED, FAILED
   *   PRE_HARVEST → HARVESTING, GROWING, FAILED
   *   HARVESTING → HARVESTED, FAILED
   *   HARVESTED → CLOSED
   *   TRANSFERRED → CLOSED
   *   FAILED → CLOSED
   *   CLOSED → (terminal)
   */
  canTransitionTo(batch: Batch, newStatus: BatchStatus): boolean {
    return this.lifecyclePolicy.canTransitionStatus(batch.status, newStatus);
  }

  /**
   * Is the batch in an active production state?
   *
   * WHY the status set comes from OPERATIONAL_BATCH_STATUSES rather than an
   * inline literal: `assertFeedable` below and the running-FCR sweep scope
   * (LIVE_BATCH_FCR_SCOPE_SQL) must agree with this method exactly. The SQL copy
   * drifted to ('ACTIVE','GROWING') and left PRE_HARVEST/HARVESTING batches
   * feedable-but-unwatched. One constant removes the drift surface.
   */
  isOperational(batch: Batch): boolean {
    return OPERATIONAL_BATCH_STATUSES.includes(batch.status);
  }

  isCleanerFishBatch(batch: Batch): boolean {
    return batch.batchType === BatchType.CLEANER_FISH;
  }

  isProductionBatch(batch: Batch): boolean {
    return batch.batchType === BatchType.PRODUCTION;
  }

  /**
   * Guard a batch against feeding when it has no live fish to feed.
   *
   * WHY: Recording feed against an emptied (currentQuantity ≤ 0) or
   * non-feedable batch silently inflates totalFeedConsumed with no
   * corresponding biomass, which corrupts FCR (feed without growth) and lets
   * operators log feed against harvested/closed/failed batches. Feeding is only
   * valid while the batch is in an operational production state AND still holds
   * live fish. The feedable status set is exactly isOperational() — ACTIVE,
   * GROWING, PRE_HARVEST, HARVESTING — and excludes HARVESTED, CLOSED, FAILED,
   * TRANSFERRED, QUARANTINE.
   *
   * WHAT: throws BadRequestException when the batch is empty or its status is
   * not feedable. Returns void on success so feeding handlers can call it as a
   * precondition assertion. This is the cross-lane primitive the feed lane
   * wires into its feeding handlers.
   */
  assertFeedable(batch: Batch): void {
    if (batch.currentQuantity <= 0) {
      throw new BadRequestException(
        `Batch ${batch.id} has no live fish (currentQuantity=${batch.currentQuantity}); ` +
          `feeding an empty batch would inflate feed consumption without growth and corrupt FCR.`,
      );
    }
    if (!this.isOperational(batch)) {
      throw new BadRequestException(
        `Batch ${batch.id} is not feedable in status ${batch.status}; ` +
          `feeding is only permitted while ACTIVE, GROWING, PRE_HARVEST or HARVESTING.`,
      );
    }
  }
}
