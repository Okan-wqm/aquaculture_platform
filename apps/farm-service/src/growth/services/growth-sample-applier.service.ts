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
 * WHAT: both writers call `apply` inside their own transaction, after taking
 * the unit lock in the canonical order (`lockUnitForGrowth`, wrapped in
 * `withUnitLockRetry` at the call site). `apply` writes the sample onto the
 * batch's `weight.actual` unless the batch already holds a later weighing,
 * re-bases the weighed batch's share of the tank through the unit weight
 * writer (`BiomassGrowthApplierService.applyMeasuredWeight`), and, when the
 * tank's weight moved, refreshes the farm-stock read model and reprices the
 * tank's live day plan in the same transaction.
 *
 * @module Growth/Services
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import {
  BiomassGrowthApplierService,
  type LockedUnit,
  weighingDay,
} from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { GrowthMeasurement } from '../entities/growth-measurement.entity';

/**
 * Growth statistics (StatisticalSummary.weight.confidenceInterval) are computed
 * at a 95% confidence interval, so an applied sample stamps the batch weight
 * provenance with a 95% confidence level.
 */
export const WEIGHT_SAMPLE_CONFIDENCE_PERCENT = 95;

/** The fields of a sample `apply` reads. */
export type AppliedSample = Pick<
  GrowthMeasurement,
  'batchId' | 'tankId' | 'averageWeight' | 'estimatedBiomass' | 'measurementDate' | 'sampleSize'
>;

@Injectable()
export class GrowthSampleApplierService {
  private readonly logger = new Logger(GrowthSampleApplierService.name);

  constructor(
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly dayPlanRecalc: DayPlanRecalcService,
    private readonly farmStockProjection: FarmStockProjectionService,
  ) {}

  /**
   * The unit a sample weighed: the tank it names, else the one tank that holds
   * the batch, else `null` when no tank holds it (a pond-held or not yet
   * allocated batch, whose sample has no tank to move).
   *
   * @throws BadRequestException when the batch is stocked in more than one
   *   tank and the sample names none. Each tank's fish have their own weight,
   *   and moving every share to one tank's sample would re-base fish nobody
   *   weighed.
   */
  async unitOf(
    manager: EntityManager,
    tenantId: string,
    sample: Pick<GrowthMeasurement, 'batchId' | 'tankId'>,
  ): Promise<string | null> {
    if (sample.tankId) return sample.tankId;

    // Membership as every other reader defines it: the primary batch, or an
    // entry in batchDetails[]. Containment keeps each parameter one type.
    const rows: Array<{ tankId: string }> = await manager.query(
      `SELECT tb."tankId" AS "tankId"
         FROM "tank_batches" tb
        WHERE tb."tenantId" = $1
          AND (tb."primaryBatchId" = $2 OR tb."batchDetails" @> $3::jsonb)
        ORDER BY tb."tankId" ASC`,
      [tenantId, sample.batchId, JSON.stringify([{ batchId: sample.batchId }])],
    );
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0]!.tankId;
    throw new BadRequestException(
      `Batch ${sample.batchId} is stocked in ${rows.length} tanks; ` +
        'a growth sample must name the tank its fish were taken from.',
    );
  }

  /**
   * Applies a sample as current weight. Runs inside the caller's tenant
   * transaction. `unitId` is what `unitOf` returned and `locked` the lock the
   * caller took on it (both null when no tank holds the batch).
   *
   * @returns the locked batch row, saved.
   * @throws BadRequestException when the sample names a tank that does not
   *   hold the batch.
   */
  async apply(
    manager: EntityManager,
    tenantId: string,
    sample: AppliedSample,
    unitId: string | null,
    locked: LockedUnit | null,
  ): Promise<Batch> {
    if (unitId !== null && (locked === null || !locked.batches.has(sample.batchId))) {
      throw new BadRequestException(
        `Batch ${sample.batchId} is not stocked in tank ${unitId}; ` +
          'a growth sample must name the tank its fish were taken from.',
      );
    }

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

    let unitMoved = false;
    if (unitId !== null && locked !== null) {
      unitMoved = await this.growthApplier.applyMeasuredWeight(manager, tenantId, locked, {
        batchId: sample.batchId,
        avgWeightG: sample.averageWeight,
        measuredAt: sample.measurementDate,
      });
      if (unitMoved) {
        await this.farmStockProjection.refreshContainers(manager, tenantId, [unitId]);
        // The remaining meals of today are re-costed, and the band re-resolved,
        // from the weight that was measured: the ration does not wait for the
        // next 06:00 plan, which reads the re-based tank as well.
        await this.dayPlanRecalc.recalcForUnit(manager, tenantId, unitId, 'growth_sample');
      }
    }

    if (!batchMoved && !unitMoved) {
      this.logger.log(
        `Growth sample for batch ${sample.batchId} dated ${weighingDay(sample.measurementDate)} ` +
          'is older than its last weighing; kept as history, current weight unchanged.',
      );
    }
    return batch;
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
      weighingDay(sample.measurementDate) < weighingDay(actual.lastMeasuredAt)
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
