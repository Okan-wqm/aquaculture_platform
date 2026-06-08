import { Injectable } from '@nestjs/common';
import { Batch, BatchStatus, BatchType } from '../entities/batch.entity';
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
   * Current biomass in kg.
   * Priority: actual measurement → theoretical calculation → initial stocking.
   */
  getCurrentBiomass(batch: Batch): number {
    if (batch.weight?.actual?.totalBiomass) {
      return batch.weight.actual.totalBiomass;
    }
    if (batch.weight?.theoretical?.totalBiomass) {
      return batch.weight.theoretical.totalBiomass;
    }
    return batch.weight?.initial?.totalBiomass || 0;
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

  /**
   * Feed Conversion Ratio (FCR).
   * FCR = totalFeedConsumed / (currentBiomass - initialBiomass + mortalityBiomass)
   *
   * Lower is better — 1.0 means 1kg feed per 1kg weight gain.
   * Typical range: 1.0-2.5 for salmon, 1.5-3.0 for seabass.
   *
   * @param mortalityBiomass - Estimated biomass lost to mortality (kg)
   */
  calculateFCR(batch: Batch, mortalityBiomass: number = 0): number {
    const initialBiomass = batch.weight?.initial?.totalBiomass || 0;
    const currentBiomass = this.getCurrentBiomass(batch);
    const weightGain = currentBiomass - initialBiomass + mortalityBiomass;

    if (weightGain <= 0 || batch.totalFeedConsumed <= 0) return 0;
    return batch.totalFeedConsumed / weightGain;
  }

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

  /** Is the batch in an active production state? */
  isOperational(batch: Batch): boolean {
    return [
      BatchStatus.ACTIVE,
      BatchStatus.GROWING,
      BatchStatus.PRE_HARVEST,
      BatchStatus.HARVESTING,
    ].includes(batch.status);
  }

  isCleanerFishBatch(batch: Batch): boolean {
    return batch.batchType === BatchType.CLEANER_FISH;
  }

  isProductionBatch(batch: Batch): boolean {
    return batch.batchType === BatchType.PRODUCTION;
  }
}
