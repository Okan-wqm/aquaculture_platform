/**
 * CreateCleanerBatchHandler
 *
 * CreateCleanerBatchCommand'ı işler ve yeni cleaner fish batch oluşturur.
 *
 * The handler wraps the single `batches_v2` insert and the
 * `CleanerFishBatchCreated` outbox enqueue in a DataSource
 * transaction — either both land or neither does. Without that
 * atomicity, a DB commit followed by an enqueue failure would
 * leave a cleaner-fish batch visible via queries but silent on
 * the event bus, breaking every downstream timeline projection
 * right at the lifecycle starting point.
 *
 * @module Batch/Handlers
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso,
  createBaseEvent,
  type CleanerFishBatchCreatedEvent,
} from '@platform/event-contracts';
import { CreateCleanerBatchCommand } from '../commands/create-cleaner-batch.command';
import { Batch, BatchStatus, BatchInputType, BatchType } from '../entities/batch.entity';
import { Species } from '../../species/entities/species.entity';
import { CodeGeneratorService } from '../../database/services/code-generator.service';

@Injectable()
@CommandHandler(CreateCleanerBatchCommand)
export class CreateCleanerBatchHandler implements ICommandHandler<CreateCleanerBatchCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: CreateCleanerBatchCommand): Promise<Batch> {
    const { tenantId, payload, createdBy } = command;

    // Species kontrolü - cleaner fish olmalı
    const species = await this.speciesRepository.findOne({
      where: { id: payload.speciesId, tenantId, isActive: true, isDeleted: false },
    });

    if (!species) {
      throw new BadRequestException(`Species ${payload.speciesId} bulunamadı veya aktif değil`);
    }

    if (!species.isCleanerFish) {
      throw new BadRequestException(
        `Species ${species.commonName} cleaner fish değil. Cleaner fish batch'i oluşturmak için isCleanerFish=true olan bir tür seçmelisiniz.`
      );
    }

    // Batch numarası oluştur - CFB prefix (Cleaner Fish Batch)
    const generatedCode = await this.codeGenerator.generateCode({
      prefix: 'CFB',
      tenantId,
      entityType: 'CleanerBatch',
    });
    const batchNumber = generatedCode?.code || `CFB-${new Date().getFullYear()}-${Date.now()}`;

    // Başlangıç biomass hesapla
    const initialBiomass = (payload.initialQuantity * payload.initialAvgWeightG) / 1000;

    // Cleaner fish için default FCR (genelde 1.0-1.2)
    const targetFCR = 1.0;

    // Batch entity oluştur
    const batch = this.batchRepository.create({
      tenantId,
      batchNumber,
      name: `${species.commonName} - ${batchNumber}`,
      speciesId: payload.speciesId,
      inputType: BatchInputType.JUVENILES, // Cleaner fish genelde juvenile olarak gelir
      batchType: BatchType.CLEANER_FISH,
      sourceType: payload.sourceType,
      sourceLocation: payload.sourceLocation,
      initialQuantity: payload.initialQuantity,
      currentQuantity: payload.initialQuantity,
      totalMortality: 0,
      cullCount: 0,
      totalFeedConsumed: 0,
      totalFeedCost: 0,
      stockedAt: payload.stockedAt,
      supplierId: payload.supplierId,
      purchaseCost: payload.purchaseCost,
      currency: payload.currency || 'TRY',
      status: BatchStatus.ACTIVE, // Cleaner fish doğrudan aktif
      isActive: true,
      notes: payload.notes,
      createdBy,

      // Weight tracking
      weight: {
        initial: {
          avgWeight: payload.initialAvgWeightG,
          totalBiomass: initialBiomass,
          measuredAt: new Date(),
        },
        theoretical: {
          avgWeight: payload.initialAvgWeightG,
          totalBiomass: initialBiomass,
          lastCalculatedAt: new Date(),
          basedOnFCR: targetFCR,
        },
        actual: {
          avgWeight: payload.initialAvgWeightG,
          totalBiomass: initialBiomass,
          lastMeasuredAt: new Date(),
          sampleSize: 0,
          confidencePercent: 0,
        },
        variance: {
          weightDifference: 0,
          percentageDifference: 0,
          isSignificant: false,
        },
      },

      // FCR tracking
      fcr: {
        target: targetFCR,
        actual: 0,
        theoretical: targetFCR,
        isUserOverride: false,
        lastUpdatedAt: new Date(),
      },

      // Feeding summary
      feedingSummary: {
        totalFeedGiven: 0,
        totalFeedCost: 0,
      },

      // Growth metrics
      growthMetrics: {
        growthRate: {
          actual: 0,
          target: 0,
          variancePercent: 0,
        },
        daysInProduction: 0,
        projections: {
          confidenceLevel: 'low',
        },
      },

      // Mortality summary
      mortalitySummary: {
        totalMortality: 0,
        mortalityRate: 0,
      },
    });

    // Atomic: save batch + enqueue event. Commit together or neither.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const savedBatch = await queryRunner.manager.save(Batch, batch);

      const event: CleanerFishBatchCreatedEvent = {
        ...createBaseEvent<CleanerFishBatchCreatedEvent>(
          'CleanerFishBatchCreated',
          tenantId,
          { aggregateId: savedBatch.id, aggregateType: 'Batch' },
        ),
        cleanerBatchId: savedBatch.id,
        batchNumber: savedBatch.batchNumber,
        speciesId: savedBatch.speciesId,
        speciesName: species.commonName,
        sourceType: payload.sourceType,
        sourceLocation: payload.sourceLocation,
        supplierId: payload.supplierId,
        initialQuantity: savedBatch.initialQuantity,
        initialAvgWeightG: payload.initialAvgWeightG,
        initialBiomassKg: initialBiomass,
        stockedAt: toEventIso(savedBatch.stockedAt),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      await queryRunner.commitTransaction();
      return savedBatch;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
