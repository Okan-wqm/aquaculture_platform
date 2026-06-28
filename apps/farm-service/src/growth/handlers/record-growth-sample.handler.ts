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
 * # Why we take a pessimistic lock on the batch
 *
 * The batch row is re-read INSIDE the transaction with
 * pessimistic_write (mirroring record-mortality). Under derive-on-read
 * biomass, the only fields a growth sample may mutate on the batch are
 * the weight.actual provenance fields (avgWeight, totalBiomass,
 * lastMeasuredAt, sampleSize, confidencePercent). We write ONLY those
 * onto the freshly-locked in-tx row instead of saving a stale,
 * externally-loaded snapshot of the whole entity — otherwise a sample
 * that loaded the batch before a concurrent mortality/cull committed
 * would, on save, revert that handler's currentQuantity / feed
 * decrements (lost-update). Locking + a field-scoped write makes the
 * lost-update structurally impossible.
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
      const saved = await queryRunner.manager.save(GrowthMeasurement, measurement);

      if (saved.updateBatchWeight) {
        // Re-read the batch under pessimistic_write INSIDE the tx so the write
        // targets the live row, not the stale snapshot loaded above. We mutate
        // ONLY the weight.actual provenance fields — never the whole entity —
        // so a concurrent mortality/cull/harvest that decremented
        // currentQuantity/feed cannot be reverted by this sample (lost-update).
        const lockedBatch = await queryRunner.manager.findOne(Batch, {
          where: { id: payload.batchId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedBatch) {
          throw new NotFoundException(`Batch ${payload.batchId} bulunamadı`);
        }
        if (lockedBatch.weight?.actual) {
          lockedBatch.weight.actual.avgWeight = saved.averageWeight;
          // totalBiomass is the at-sample snapshot of the JSONB provenance
          // block; current biomass is derived on read from the live count ×
          // avgWeight, so this stored figure is provenance, not authority.
          lockedBatch.weight.actual.totalBiomass = saved.estimatedBiomass;
          lockedBatch.weight.actual.lastMeasuredAt = saved.measurementDate;
          lockedBatch.weight.actual.sampleSize = saved.sampleSize;
          // Statistics are computed at a 95% confidence interval
          // (StatisticalSummary.weight.confidenceInterval), so the provenance
          // confidence level for this sample is 95%.
          lockedBatch.weight.actual.confidencePercent = WEIGHT_SAMPLE_CONFIDENCE_PERCENT;
        }
        await queryRunner.manager.save(Batch, lockedBatch);

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
