/**
 * RecordGrowthSampleHandler
 *
 * RecordGrowthSampleCommand'ı işler ve yeni büyüme ölçümü oluşturur.
 *
 * @module Growth/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
// TODO: EventBus integration - import { EventBus } from '@platform/event-bus';
import { RecordGrowthSampleCommand } from '../commands/record-growth-sample.command';
import { GrowthMeasurement, MeasurementType, MeasurementMethod } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { FCRCalculationService } from '../services/fcr-calculation.service';

@Injectable()
@CommandHandler(RecordGrowthSampleCommand)
export class RecordGrowthSampleHandler implements ICommandHandler<RecordGrowthSampleCommand, GrowthMeasurement> {
  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(FeedingRecord)
    private readonly feedingRepository: Repository<FeedingRecord>,
    private readonly fcrService: FCRCalculationService,
    // TODO: EventBus integration
    // private readonly eventBus: EventBus,
  ) {}

  async execute(command: RecordGrowthSampleCommand): Promise<GrowthMeasurement> {
    const { tenantId, payload, userId } = command;

    // Batch'i doğrula
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

    // Minimum örnek sayısı kontrolü
    if (payload.individualMeasurements.length < 3) {
      throw new BadRequestException('Minimum 3 adet bireysel ölçüm gerekli');
    }

    // Önceki ölçümü bul
    const previousMeasurement = await this.measurementRepository.findOne({
      where: { tenantId, batchId: payload.batchId },
      order: { measurementDate: 'DESC' },
    });

    // Ölçüm kaydı oluştur
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
      samplePercent: 0, // calculateDerivedFields'da hesaplanacak

      individualMeasurements: payload.individualMeasurements,
      statistics: {} as any, // calculateStatistics'te doldurulacak

      averageWeight: 0, // calculateStatistics'te hesaplanacak
      weightCV: 0, // calculateStatistics'te hesaplanacak
      estimatedBiomass: 0, // calculateDerivedFields'da hesaplanacak

      previousBiomass: previousMeasurement?.estimatedBiomass,

      conditions: payload.conditions,
      measuredBy: payload.measuredBy || userId,
      notes: payload.notes,
      updateBatchWeight: payload.updateBatchWeight ?? true,
    });

    // İstatistikleri hesapla
    measurement.calculateStatistics();

    // Büyüme karşılaştırması
    if (previousMeasurement) {
      const daysSincePrevious = this.calculateDaysBetween(
        previousMeasurement.measurementDate,
        payload.measurementDate,
      );

      const dailyGrowthRate = daysSincePrevious > 0
        ? (measurement.averageWeight - previousMeasurement.averageWeight) / daysSincePrevious
        : 0;

      // SGR hesapla
      const sgr = this.calculateSGR(
        previousMeasurement.averageWeight,
        measurement.averageWeight,
        daysSincePrevious,
      );

      // Theoretical weight hesapla
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

    // Performans değerlendirmesi
    measurement.evaluatePerformance();

    // FCR analizi
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

    // Önerilen aksiyonları oluştur
    measurement.generateSuggestedActions();

    // Kaydet
    const saved = await this.measurementRepository.save(measurement);

    // Batch ağırlığını güncelle
    if (saved.updateBatchWeight) {
      await this.updateBatchWeight(batch, saved);
    }

    return saved;
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

  private async updateBatchWeight(batch: Batch, measurement: GrowthMeasurement): Promise<void> {
    // Batch'in actual weight tracking'ini güncelle
    if (batch.weight && batch.weight.actual) {
      batch.weight.actual.avgWeight = measurement.averageWeight;
      batch.weight.actual.totalBiomass = measurement.estimatedBiomass;
      batch.weight.actual.lastMeasuredAt = measurement.measurementDate;
    }

    await this.batchRepository.save(batch);

    // Measurement'ı işlenmiş olarak işaretle
    measurement.isProcessed = true;
    await this.measurementRepository.save(measurement);
  }
}
