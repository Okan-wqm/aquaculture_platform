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
 * # Why we didn't take a pessimistic lock on the batch
 *
 * Unlike culls / mortality (which race on `currentQuantity` decrement
 * and need serialising), two concurrent growth samples on the same
 * batch write distinct `growth_measurements` rows and then each
 * overwrite `batch.weight.actual` with their own snapshot. Last-
 * writer-wins on the batch weight is the intended semantics — a
 * newer sample should overwrite an older one. No lock needed.
 *
 * @module Growth/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  type GrowthSampleRecordedEvent,
} from '@platform/event-contracts';
import { RecordGrowthSampleCommand } from '../commands/record-growth-sample.command';
import { GrowthMeasurement, MeasurementType, MeasurementMethod, StatisticalSummary } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { FCRCalculationService } from '../services/fcr-calculation.service';
import { BackdatePolicyService } from '../../common/services/backdate-policy.service';

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

    // Batch'i doğrula — read outside the tx is fine; the batch row
    // is validated again (implicitly) when we save it inside the tx.
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const saved = await queryRunner.manager.save(GrowthMeasurement, measurement);

      if (saved.updateBatchWeight) {
        if (batch.weight && batch.weight.actual) {
          batch.weight.actual.avgWeight = saved.averageWeight;
          batch.weight.actual.totalBiomass = saved.estimatedBiomass;
          batch.weight.actual.lastMeasuredAt = saved.measurementDate;
        }
        await queryRunner.manager.save(Batch, batch);

        saved.isProcessed = true;
        await queryRunner.manager.save(GrowthMeasurement, saved);
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
        measurementDate:
          saved.measurementDate instanceof Date
            ? saved.measurementDate
            : new Date(saved.measurementDate),
        performance: saved.performance,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
