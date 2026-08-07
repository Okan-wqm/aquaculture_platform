/**
 * RecordGrowthSampleHandler
 *
 * Records a new growth measurement for a batch, updates the batch's
 * running weight snapshot, and publishes a `GrowthSampleRecorded`
 * domain event via the transactional outbox so downstream consumers
 * (analytics, AI insights, SGR-degradation alerting) can react.
 *
 * # Transactional outbox
 *
 * The three writes (measurement insert, batch weight update, and
 * isProcessed flip on the measurement) commit atomically with the
 * outbox row via a single DataSource transaction. A crash mid-flight
 * rolls back everything — the outbox never sees an event whose
 * corresponding domain write was lost, and the domain never commits
 * a measurement whose event failed to enqueue.
 *
 * # Why a weighing reaches the TANK, not just the batch
 *
 * This handler used to save the measurement, stamp `Batch.weight.actual`,
 * and stop. Every plan / band / rate path in the platform reads
 * `TankBatch.avgWeightG` — the meal-plan generator, the day-plan recalc,
 * the feed forecast and the tanks-page feed selector — so the measurement
 * never reached the feeding plan. Biomass evolved forever as
 * `biomass += fedKg / assumedFCR`: weighing 200 fish and finding them 40%
 * off changed NOTHING about how much feed the tank got the next morning.
 *
 * The fix routes the sample through the SAME primitive the FCR path uses
 * (`BiomassGrowthApplierService`) — same canonical lock order, same
 * proportional distribution across `batchDetails[]`, DIFFERENT provenance —
 * and then reprices the unit's live day plan. A weighing is now the
 * authoritative input to the feeding plan, which is the whole point.
 *
 * A weighing asserts an average WEIGHT, never a population: the fish count
 * stays owned by `TankBatchService.applyBatchDelta`. See
 * `BiomassGrowthApplierService.reconcileMeasuredWeight`.
 *
 * # Why we take a pessimistic lock on the batch
 *
 * The unit is locked in the canonical order (all of the unit's batches by
 * batchId ASC, then the TankBatch row) via `lockUnitForGrowth`, and the
 * sampled batch is taken FROM that locked set — acquiring the batch lock
 * first and the unit lock second would invert the order two concurrent
 * writers on the same tank rely on (AB-BA deadlock). We then mutate ONLY
 * the weight provenance fields on the freshly-locked in-tx rows instead of
 * saving a stale, externally-loaded snapshot of the whole entity —
 * otherwise a sample that loaded the batch before a concurrent
 * mortality/cull committed would, on save, revert that handler's
 * currentQuantity / feed decrements (lost-update). Locking + a
 * field-scoped write makes the lost-update structurally impossible.
 *
 * @module Growth/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type GrowthSampleRecordedEvent,
} from '@platform/event-contracts';
import { RecordGrowthSampleCommand } from '../commands/record-growth-sample.command';
import { GrowthMeasurement, MeasurementType, MeasurementMethod, StatisticalSummary } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { FCRCalculationService } from '../services/fcr-calculation.service';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import {
  BiomassGrowthApplierService,
  type MeasurementProvenance,
} from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { resolveUnitHoldingBatch } from '../../batch/utils/unit-for-batch.util';

// Growth statistics (StatisticalSummary.weight.confidenceInterval) are computed
// at a 95% confidence interval, so a recorded sample stamps the batch weight
// provenance with a 95% confidence level.
const WEIGHT_SAMPLE_CONFIDENCE_PERCENT = 95;

@Injectable()
@CommandHandler(RecordGrowthSampleCommand)
export class RecordGrowthSampleHandler implements ICommandHandler<RecordGrowthSampleCommand, GrowthMeasurement> {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    private readonly fcrService: FCRCalculationService,
    private readonly backdatePolicy: BackdatePolicyService,
    private readonly outboxPublisher: OutboxPublisher,
    // The SAME primitive the FCR path writes through — one writer of a unit's
    // weight, two provenances. A parallel measurement writer would re-open the
    // divergence this phase closes.
    private readonly growthApplier: BiomassGrowthApplierService,
    // A weighing that does not reprice the live day plan is a weighing the
    // operator cannot act on today; the next 06:00 plan already reads the
    // re-based TankBatch aggregates.
    private readonly recalcService: DayPlanRecalcService,
  ) {}

  async execute(command: RecordGrowthSampleCommand): Promise<GrowthMeasurement> {
    const { tenantId, payload, userId } = command;

    // Backdate policy: growth measurements support a longer historical
    // window than feeding (GROWTH_BACKDATE_LIMIT_DAYS, default 30) to
    // accommodate monthly sampling cycles, but still rejects future
    // dates and out-of-window past values. Out-of-order measurements
    // corrupt SGR and condition-factor derivations, so the limit bounds
    // the damage.
    const proposedDate: Date =
      payload.measurementDate instanceof Date
        ? payload.measurementDate
        : new Date(payload.measurementDate);
    this.backdatePolicy.validate({
      context: 'growth',
      proposedDate,
      subjectLabel: `batch ${payload.batchId}`,
    });

    // Batch'i doğrula — this non-tx read is for validation, species relation
    // (FCR / theoretical-weight inputs) and population defaults only. The
    // AUTHORITATIVE write target is re-read under pessimistic_write inside the
    // transaction below; nothing on this snapshot is ever saved.
    const batch = await this.batchRepository.findOne({
      where: { id: payload.batchId, tenantId },
      relations: ['species'],
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${payload.batchId} bulunamadı`);
    }

    if (!batch.isActive) {
      throw new BadRequestException('Aktif olmayan batch için ölçüm yapılamaz');
    }

    if (payload.individualMeasurements.length < 3) {
      throw new BadRequestException('Minimum 3 adet bireysel ölçüm gerekli');
    }

    // Önceki ölçümü bul — used only for growth-comparison / FCR, so
    // a non-tx read is adequate.
    const previousMeasurement = await this.measurementRepository.findOne({
      where: { tenantId, batchId: payload.batchId },
      order: { measurementDate: 'DESC' },
    });

    const measurement = this.measurementRepository.create({
      tenantId,
      batchId: payload.batchId,
      tankId: payload.tankId,
      pondId: payload.pondId,

      measurementDate: payload.measurementDate,
      measurementType: payload.measurementType || MeasurementType.ROUTINE,
      measurementMethod: payload.measurementMethod || MeasurementMethod.MANUAL_SCALE,

      sampleSize: payload.individualMeasurements.length,
      populationSize: payload.populationSize || batch.currentQuantity,
      samplePercent: 0,

      individualMeasurements: payload.individualMeasurements,
      statistics: {} as StatisticalSummary,

      averageWeight: 0,
      weightCV: 0,
      estimatedBiomass: 0,

      previousBiomass: previousMeasurement?.estimatedBiomass,

      conditions: payload.conditions,
      measuredBy: payload.measuredBy || userId,
      notes: payload.notes,
      updateBatchWeight: payload.updateBatchWeight ?? true,
    });

    measurement.calculateStatistics();

    if (previousMeasurement) {
      const daysSincePrevious = this.calculateDaysBetween(
        previousMeasurement.measurementDate,
        payload.measurementDate,
      );

      const dailyGrowthRate = daysSincePrevious > 0
        ? (measurement.averageWeight - previousMeasurement.averageWeight) / daysSincePrevious
        : 0;

      const sgr = this.calculateSGR(
        previousMeasurement.averageWeight,
        measurement.averageWeight,
        daysSincePrevious,
      );

      const theoreticalWeight = this.calculateTheoreticalWeight(
        previousMeasurement.averageWeight,
        daysSincePrevious,
        batch.species?.growthParameters?.avgDailyGrowth || 1,
      );

      const variance = measurement.averageWeight - theoreticalWeight;
      const variancePercent = theoreticalWeight > 0 ? (variance / theoreticalWeight) * 100 : 0;

      measurement.growthComparison = {
        theoreticalWeight,
        actualWeight: measurement.averageWeight,
        variance,
        variancePercent,
        previousMeasurementId: previousMeasurement.id,
        daysSincePrevious,
        dailyGrowthRate,
        specificGrowthRate: sgr,
      };
    }

    measurement.evaluatePerformance();

    if (previousMeasurement) {
      const fcrResult = await this.fcrService.calculatePeriodFCR({
        tenantId,
        batchId: payload.batchId,
        startDate: previousMeasurement.measurementDate,
        endDate: payload.measurementDate,
        targetFCR: batch.fcr?.target || 1.5,
      });

      if (fcrResult.isValid) {
        measurement.fcrAnalysis = fcrResult.analysis;
      }
    }

    measurement.generateSuggestedActions();

    // Atomic block: save measurement → (optional) update batch weight
    // → flip isProcessed → enqueue event → commit. Rolls back together.
    // runInTenantTransaction pins search_path to tenant_<uuid> for the whole tx
    // (pool-checkout routing alone is not sufficient for transactional writes,
    // per pinTenantTransactionSearchPath), so the locked read + per-tenant
    // writes (batches_v2, growth_measurements) land in the correct schema.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const saved = await manager.save(GrowthMeasurement, measurement);

      // The unit this sample sizes. Fail-closed when the batch spans several
      // tanks and the operator did not name one (see resolveUnitHoldingBatch).
      const unitId = await resolveUnitHoldingBatch(
        manager,
        tenantId,
        payload.batchId,
        payload.tankId,
      );

      if (saved.updateBatchWeight) {
        // Statistics are computed at a 95% confidence interval
        // (StatisticalSummary.weight.confidenceInterval), so the provenance
        // confidence level for this sample is 95%.
        const provenance: MeasurementProvenance = {
          source: 'measurement',
          measurementId: saved.id,
          measuredAt: saved.measurementDate,
          sampleSize: saved.sampleSize,
          confidencePercent: WEIGHT_SAMPLE_CONFIDENCE_PERCENT,
        };

        // K-1 canonical lock order: ALL of the unit's batches (batchId ASC)
        // then the TankBatch row. Locking the sampled batch first and the unit
        // second would invert the order every other writer on this tank uses.
        const locked = unitId
          ? await this.growthApplier.lockUnitForGrowth(manager, tenantId, unitId)
          : null;

        if (locked) {
          if (!locked.batches.has(payload.batchId)) {
            // A weighing filed against a tank that does not hold this batch
            // would move a DIFFERENT cohort's weight. Reject rather than
            // silently re-base the wrong fish.
            throw new BadRequestException(
              `Batch ${payload.batchId} is not stocked in unit ${unitId} — ` +
                'a growth sample must name the tank the fish were taken from.',
            );
          }
          // THE severed link, restored: the measured average weight moves the
          // unit's avgWeightG / totalBiomassKg / batchDetails onto the MEASURED
          // track (and stamps lastSamplingAt). The count is untouched.
          await this.growthApplier.reconcileMeasuredWeight(
            manager,
            tenantId,
            locked,
            saved.averageWeight,
            provenance,
          );
        } else {
          // The batch is in no unit (pond-held or not yet allocated): there is
          // no tank stock to re-base, but the batch's measured-weight
          // provenance is still a fact worth recording. Same single writer, so
          // the persisted block has the same shape either way.
          const lockedBatch = await manager.findOne(Batch, {
            where: { id: payload.batchId, tenantId },
            lock: { mode: 'pessimistic_write' },
          });
          if (!lockedBatch) {
            throw new NotFoundException(`Batch ${payload.batchId} bulunamadı`);
          }
          this.growthApplier.stampBatchWeight(
            lockedBatch,
            { biomassKg: saved.estimatedBiomass, quantity: saved.populationSize },
            provenance,
          );
          await manager.save(Batch, lockedBatch);
        }

        saved.isProcessed = true;
        await manager.save(GrowthMeasurement, saved);

        if (unitId && locked) {
          // Reprice the unit's live day plan from the MEASURED biomass: the
          // remaining meals of today are re-costed and a band transition is
          // evaluated against the weight that was actually observed. Runs in
          // this transaction, so the plan can never reflect a measurement that
          // rolled back.
          await this.recalcService.recalcForUnit(manager, tenantId, unitId, 'growth_sample');
        }
      }

      const event: GrowthSampleRecordedEvent = {
        ...createBaseEvent<GrowthSampleRecordedEvent>('GrowthSampleRecorded', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'GrowthMeasurement',
        }),
        batchId: saved.batchId,
        measurementId: saved.id,
        sampleSize: saved.sampleSize,
        averageWeightG: saved.averageWeight,
        weightCV: saved.weightCV,
        measurementDate: toEventIso(saved.measurementDate),
        performance: saved.performance,
        // Carries the re-based unit so the farm-stock read model (mobile) can
        // refresh the container whose weight this sample just changed.
        ...(unitId ? { tankId: unitId } : {}),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      return saved;
    });
  }

  private calculateDaysBetween(start: Date, end: Date): number {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffTime = endDate.getTime() - startDate.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  private calculateSGR(initialWeight: number, finalWeight: number, days: number): number {
    if (days <= 0 || initialWeight <= 0) return 0;
    return ((Math.log(finalWeight) - Math.log(initialWeight)) / days) * 100;
  }

  private calculateTheoreticalWeight(
    startWeight: number,
    days: number,
    dailyGrowthRate: number,
  ): number {
    return startWeight + (days * dailyGrowthRate);
  }
}
