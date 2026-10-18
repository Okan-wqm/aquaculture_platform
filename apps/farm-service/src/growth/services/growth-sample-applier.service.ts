/**
 * GrowthSampleApplierService — the one way a growth sample becomes current
 * weight (FARM-CRITICAL-454, FARM-MEDIUM-453).
 *
 * WHY: a weighing is the only measurement of a batch's weight, and every
 * ration path sizes feed from the weight of the TANK, not of the batch: the
 * 06:00 day plan, the intra-day recalc and the feed forecast all read
 * `tank_batches`. The two growth-sample writers (record a sample; apply a
 * stored one later) each wrote the sample onto `Batch.weight.actual` and
 * stopped, so the tank's weight was moved only by the FCR projection and a
 * weighing reached no ration. They also wrote any sample over a later one, so
 * a backdated entry put the batch's weight back in time.
 *
 * WHAT: both writers call `applySample` inside their own transaction, wrapped
 * in `withUnitLockRetry` at the call site. `applySample` finds the unit the
 * sample weighed, takes the unit lock in the canonical order
 * (`lockUnitForGrowth`), writes the sample onto the batch's `weight.actual`
 * unless the batch already holds a later weighing, re-bases the weighed
 * batch's share of the unit through the unit weight writer
 * (`BiomassGrowthApplierService.applyMeasuredWeight`), and, when the unit's
 * weight moved, refreshes the farm-stock read model and reprices the unit's
 * live day plan in the same transaction.
 *
 * The unit is found and locked here, never by the caller: a unit id and a lock
 * handed in separately could name two different units, and the re-base would
 * then land on one while the read model and the day plan of the other were
 * refreshed. Every caller of `applySample` must wrap its transaction in
 * `withUnitLockRetry` (`unit-growth-lock-composition` gate, lock delegates).
 *
 * The batch's weight and the unit's are kept apart. A sample being recorded
 * must say which unit its fish came from: naming none for a batch held in
 * several is refused whether it is applied now or stored for later, and a
 * sample applied now may not name a unit that holds none of the batch (a stored
 * one is not held to that: it may record a unit the batch has left since). A
 * sample recorded earlier and applied now cannot be corrected any more, so a
 * unit it can no longer re-base (the batch has left the unit it names, or it
 * names none and the batch is in several) does not hold back the batch's
 * weight: weight.actual takes it, and no unit moves.
 *
 * @module Growth/Services
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { FeedingUnitType } from '../../feeding-protocol/entities/protocol-assignment.entity';
import {
  BiomassGrowthApplierService,
  calendarDay,
  type LockedUnit,
  type MeasuredWeightOutcome,
} from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { feedingUnitTypeOf } from '../../feeding-protocol/services/feeding-unit-type.util';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';

/**
 * Growth statistics (StatisticalSummary.weight.confidenceInterval) are computed
 * at a 95% confidence interval, so an applied sample stamps the batch weight
 * provenance with a 95% confidence level.
 */
export const WEIGHT_SAMPLE_CONFIDENCE_PERCENT = 95;

/**
 * The fields of a sample this service reads. `tankId` or `pondId` is also
 * written: a sample that names no unit is stamped with the one unit that held
 * the batch, in the field of that unit's kind.
 */
export type AppliedSample = Pick<
  GrowthMeasurement,
  | 'batchId'
  | 'tankId'
  | 'pondId'
  | 'averageWeight'
  | 'estimatedBiomass'
  | 'measurementDate'
  | 'sampleSize'
>;

/**
 * Where a sample's fish were taken from.
 *
 * Tanks and pond units share one key space in `tank_batches` (CreateBatchHandler
 * stocks `location.tankId || location.pondId`), so a sample's `tankId`, else its
 * `pondId`, names its unit.
 */
export type SampleUnit =
  /** The sample names its unit. */
  | { readonly kind: 'named'; readonly unitId: string }
  /** The sample names none, and exactly one unit holds fish of the batch. */
  | { readonly kind: 'held'; readonly unitId: string }
  /** The sample names none, and no unit holds the batch: weight.actual only. */
  | { readonly kind: 'none' }
  /** The sample names none, and several units hold the batch. */
  | { readonly kind: 'ambiguous'; readonly unitIds: readonly string[] };

/**
 * When the sample enters. `recorded`: it is being recorded now, and its unit is
 * the operator's input, refused when it cannot be placed. `stored`: it was
 * recorded earlier (`updateBatchWeight` false) and is applied now; its unit is
 * history, and a unit it can no longer re-base leaves the batch's weight to
 * take the sample alone.
 */
export type SampleIntake = 'recorded' | 'stored';

@Injectable()
export class GrowthSampleApplierService {
  private readonly logger = new Logger(GrowthSampleApplierService.name);

  constructor(
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly dayPlanRecalc: DayPlanRecalcService,
    private readonly farmStockProjection: FarmStockProjectionService,
  ) {}

  /**
   * The unit a sample weighed: the unit it names, else the one unit holding
   * fish of the batch (membership as `BiomassGrowthApplierService.unitsHoldingBatch`
   * defines it, so an emptied tank never counts). Unlocked read; `applySample`
   * re-checks it under the lock.
   */
  async locate(
    manager: EntityManager,
    tenantId: string,
    sample: Pick<AppliedSample, 'batchId' | 'tankId' | 'pondId'>,
  ): Promise<SampleUnit> {
    const named = sample.tankId || sample.pondId;
    if (named) return { kind: 'named', unitId: named };

    const unitIds = await this.growthApplier.unitsHoldingBatch(manager, tenantId, sample.batchId);
    if (unitIds.length === 0) return { kind: 'none' };
    if (unitIds.length === 1) return { kind: 'held', unitId: unitIds[0]! };
    return { kind: 'ambiguous', unitIds };
  }

  /**
   * Records which unit a stored sample weighed, for a sample kept as history
   * (`updateBatchWeight` false). When it names none and one unit holds the
   * batch, that unit is stamped on it, so applying it later moves the unit the
   * fish were taken from, not wherever the batch is by then. A sample that
   * names none for a batch held in several units is refused, as it is when
   * applied at once: once stored, nothing can name its unit any more.
   *
   * @throws BadRequestException when the sample names no unit and several hold
   *   the batch.
   */
  async recordLocatedUnit(
    manager: EntityManager,
    tenantId: string,
    sample: AppliedSample,
  ): Promise<void> {
    const unit = await this.locate(manager, tenantId, sample);
    this.refuseAmbiguous(sample, unit);
    await this.stampLocatedUnit(manager, tenantId, sample, unit);
  }

  /**
   * Applies a sample as current weight. Runs inside the caller's tenant
   * transaction, which the caller wraps in `withUnitLockRetry`.
   *
   * @param intake `recorded` for a sample being recorded, `stored` for one
   *   recorded earlier and applied now (see SampleIntake).
   * @returns the locked batch row, saved.
   * @throws BadRequestException (`recorded` only) when the sample names a unit
   *   that holds no fish of the batch, or names none for a batch held in
   *   several units.
   * @throws ConflictException (retried by `withUnitLockRetry`) when the one
   *   unit that held the batch no longer does once it is locked.
   */
  async applySample(
    manager: EntityManager,
    tenantId: string,
    sample: AppliedSample,
    intake: SampleIntake,
  ): Promise<Batch> {
    const unit = await this.locate(manager, tenantId, sample);
    if (intake === 'recorded') this.refuseAmbiguous(sample, unit);
    const locked =
      unit.kind === 'named' || unit.kind === 'held'
        ? await this.lockHoldingUnit(manager, tenantId, sample, unit, intake)
        : null;
    await this.stampLocatedUnit(manager, tenantId, sample, unit);

    const batch = await this.growthApplier.lockBatchForWrite(
      manager,
      tenantId,
      sample.batchId,
      locked,
    );
    if (!batch) {
      throw new NotFoundException(`Batch ${sample.batchId} bulunamadı`);
    }

    const batchMoved = this.stampWeightActual(batch, sample);
    await manager.save(Batch, batch);

    let unitOutcome: MeasuredWeightOutcome | null = null;
    if (locked !== null) {
      unitOutcome = await this.growthApplier.applyMeasuredWeight(manager, tenantId, locked, {
        batchId: sample.batchId,
        avgWeightG: sample.averageWeight,
        measuredAt: sample.measurementDate,
      });
      if (unitOutcome === 'rebased') {
        // The unit is the one the lock holds: the read model and the day plan
        // refreshed are those of the unit that was re-based.
        const unitId = locked.tankBatch.tankId;
        await this.farmStockProjection.refreshContainers(manager, tenantId, [unitId]);
        // The remaining meals of today are re-costed, and the band re-resolved,
        // from the weight that was measured: the ration does not wait for the
        // next 06:00 plan, which reads the re-based unit as well.
        await this.dayPlanRecalc.recalcForUnit(manager, tenantId, unitId, 'growth_sample');
      }
    }

    if (unitOutcome === 'older_than_share') {
      this.logger.log(
        `Growth sample for batch ${sample.batchId} dated ${calendarDay(sample.measurementDate)} ` +
          `is older than what unit ${locked === null ? '-' : locked.tankBatch.tankId} already knows ` +
          '(a later weighing or later growth); kept as history, the unit is unchanged.',
      );
    } else if (locked === null && (unit.kind === 'named' || unit.kind === 'ambiguous')) {
      // Only a stored sample gets here: a recorded one was refused above.
      this.logger.log(
        `Stored growth sample for batch ${sample.batchId} dated ${calendarDay(sample.measurementDate)} ` +
          (unit.kind === 'named'
            ? `names unit ${unit.unitId}, which no longer holds the batch`
            : `names no unit, and the batch is in ${unit.unitIds.length}`) +
          `; ${batchMoved ? "applied to the batch's weight" : 'kept as history'}, no unit re-based.`,
      );
    } else if (!batchMoved && unitOutcome === null) {
      this.logger.log(
        `Growth sample for batch ${sample.batchId} dated ${calendarDay(sample.measurementDate)} ` +
          'is older than its last weighing; kept as history, current weight unchanged.',
      );
    }
    return batch;
  }

  /**
   * Locks the unit and proves, under the lock, that it holds fish of the batch.
   * A unit a recorded sample named that does not is the operator's error (400);
   * one a stored sample named is history the batch has left (`null`: no unit
   * is re-based). The one unit found by membership losing the batch between
   * the unlocked read and the lock is a race: the retry finds the unit again.
   */
  private async lockHoldingUnit(
    manager: EntityManager,
    tenantId: string,
    sample: Pick<AppliedSample, 'batchId'>,
    unit: Extract<SampleUnit, { unitId: string }>,
    intake: SampleIntake,
  ): Promise<LockedUnit | null> {
    const locked = await this.growthApplier.lockUnitForGrowth(manager, tenantId, unit.unitId);
    if (locked !== null && this.growthApplier.stockedShareOf(locked, sample.batchId) !== null) {
      return locked;
    }
    if (unit.kind === 'named') {
      if (intake === 'stored') return null;
      throw new BadRequestException(
        `Batch ${sample.batchId} is not stocked in tank ${unit.unitId}; ` +
          'a growth sample must name the tank its fish were taken from.',
      );
    }
    // The message is the retry's contract (isUnitMembershipConflict).
    throw new ConflictException(
      `Unit ${unit.unitId} batch membership changed after the growth sample located it ` +
        `(batch ${sample.batchId} has no fish there any more). Retry.`,
    );
  }

  /** A sample that names no unit, for a batch held in several, is refused. */
  private refuseAmbiguous(sample: Pick<AppliedSample, 'batchId'>, unit: SampleUnit): void {
    if (unit.kind !== 'ambiguous') return;
    throw new BadRequestException(
      `Batch ${sample.batchId} is stocked in ${unit.unitIds.length} tanks; ` +
        'a growth sample must name the tank its fish were taken from.',
    );
  }

  /**
   * A sample that named no unit records the one it was resolved to, in the
   * field of that unit's kind: a pond unit in `pondId`, any other in `tankId`
   * (tanks and ponds share the `tank_batches` key space, so the id alone does
   * not say which it is).
   */
  private async stampLocatedUnit(
    manager: EntityManager,
    tenantId: string,
    sample: AppliedSample,
    unit: SampleUnit,
  ): Promise<void> {
    if (unit.kind !== 'held') return;
    if ((await feedingUnitTypeOf(manager, tenantId, unit.unitId)) === FeedingUnitType.POND) {
      sample.pondId = unit.unitId;
    } else {
      sample.tankId = unit.unitId;
    }
  }

  /**
   * Writes the sample onto `weight.actual` unless the batch already holds a
   * weighing from a later day (FARM-MEDIUM-453). `sampleSize` 0 marks the
   * stocking placeholder CreateBatchHandler writes, whose `lastMeasuredAt` is
   * the creation time, not a weighing, so it never holds a sample back.
   *
   * totalBiomass is the at-sample snapshot of the provenance block (the typed
   * populationSize x average); current biomass is derived on read from the live
   * count. The FCR authority (FCRCalculationService.calculateFcrAtLastWeighingMany)
   * reads avgWeight, lastMeasuredAt and sampleSize as the weighing it judges and
   * takes the count on that day from the removal ledger, so the three are one
   * sample's values, written together here.
   */
  private stampWeightActual(batch: Batch, sample: AppliedSample): boolean {
    const actual = batch.weight.actual;
    if (
      actual.sampleSize > 0 &&
      calendarDay(sample.measurementDate) < calendarDay(actual.lastMeasuredAt)
    ) {
      return false;
    }
    actual.avgWeight = sample.averageWeight;
    actual.totalBiomass = sample.estimatedBiomass;
    actual.lastMeasuredAt = sample.measurementDate;
    actual.sampleSize = sample.sampleSize;
    actual.confidencePercent = WEIGHT_SAMPLE_CONFIDENCE_PERCENT;
    return true;
  }
}
