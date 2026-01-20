/**
 * CreateCleanerBatchHandler
 *
 * CreateCleanerBatchCommand'ı işler ve yeni cleaner fish batch oluşturur.
 *
 * @module Batch/Handlers
 */
import { Injectable, BadRequestException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
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
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
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

    const savedBatch = await this.batchRepository.save(batch);

    return savedBatch;
  }
}
