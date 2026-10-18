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
 * The writes (batch weight update, unit re-base, and the measurement
 * insert with its isProcessed flag) commit atomically with the outbox row
 * via a single DataSource transaction. A crash mid-flight
 * rolls back everything — the outbox never sees an event whose
 * corresponding domain write was lost, and the domain never commits
 * a measurement whose event failed to enqueue.
 *
 * # Why a sample reaches the tank and its day plan
 *
 * Every ration path sizes feed from the tank's `tank_batches` weight, so a
 * sample that stopped at `Batch.weight.actual` changed no meal
 * (FARM-CRITICAL-454). The sample is applied through
 * GrowthSampleApplierService, the same path UpdateBatchWeightFromSampleHandler
 * uses: the batch's weight.actual, the weighed batch's share of its tank, and
 * the tank's live day plan, all in this transaction.
 *
 * # Why the unit is locked first
 *
 * `applySample` locks the unit's batches (batchId ASC) and then its TankBatch
 * row with `lockUnitForGrowth`, the order every other unit writer uses, and
 * takes the batch row from that lock; locking the batch first would invert
 * the order (AB-BA deadlock). The measurement is inserted only after that:
 * its foreign key to `batches_v2` takes a KEY SHARE lock on the sampled batch,
 * and taken first that lock would sit outside the canonical order, so a unit
 * writer locking a lower batch id of the same tank could deadlock with this
 * command. Only the weight fields are written onto the freshly locked rows,
 * never an externally loaded snapshot, so a concurrent mortality/cull cannot
 * be reverted by this sample (lost-update). A membership change between the
 * unlocked lookup and the lock is retried by `withUnitLockRetry` around the
 * whole command.
 *
 * A sample kept as history (`updateBatchWeight` false) that names no unit is
 * stamped with the one unit holding the batch, so applying it later moves the
 * unit its fish were taken from; for a batch held in several units it must
 * name its unit, exactly as a sample applied at once must.
 *
 * @module Growth/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
import { GrowthSampleApplierService } from '../services/growth-sample-applier.service';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';
import { withUnitLockRetry } from '../../feeding-protocol/services/unit-lock-retry.util';

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
    private readonly sampleApplier: GrowthSampleApplierService,
  ) {}

  async execute(command: RecordGrowthSampleCommand): Promise<GrowthMeasurement> {
    return withUnitLockRetry(() => this.executeOnce(command));
  }

  private async executeOnce(command: RecordGrowthSampleCommand): Promise<GrowthMeasurement> {
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

    // Atomic block: apply the sample as current weight (unit lock first) →
    // insert the measurement → enqueue event → commit. Rolls back together.
    // runInTenantTransaction pins search_path to tenant_<uuid> for the whole tx
    // (pool-checkout routing alone is not sufficient for transactional writes,
    // per pinTenantTransactionSearchPath), so the locked reads + per-tenant
    // writes (batches_v2, tank_batches, growth_measurements, the day plan) land
    // in the correct schema.
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      // The unit lock is taken before the INSERT (see the header): both calls
      // only stamp the in-memory measurement, which is then saved once with
      // its isProcessed flag and the unit it was resolved to.
      if (measurement.updateBatchWeight) {
        await this.sampleApplier.applySample(manager, tenantId, measurement, 'recorded');
        measurement.isProcessed = true;
      } else {
        await this.sampleApplier.recordLocatedUnit(manager, tenantId, measurement);
      }
      const saved = await manager.save(GrowthMeasurement, measurement);

      const event: GrowthSampleRecordedEvent = {
        ...createBaseEvent<GrowthSampleRecordedEvent>('GrowthSampleRecorded', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'GrowthMeasurement',
        }),
        batchId: saved.batchId,
        measurementId: saved.id,
        ...(saved.tankId ? { tankId: saved.tankId } : {}),
        sampleSize: saved.sampleSize,
        averageWeightG: saved.averageWeight,
        weightCV: saved.weightCV,
        measurementDate: toEventIso(saved.measurementDate),
        performance: saved.performance,
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
