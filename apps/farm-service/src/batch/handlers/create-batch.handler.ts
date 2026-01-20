/**
 * CreateBatchHandler
 *
 * CreateBatchCommand'ı işler ve yeni batch oluşturur.
 *
 * @module Batch/Handlers
 */
import { Injectable, BadRequestException, Inject, Optional, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { CreateBatchCommand } from '../commands/create-batch.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { BatchDocument, BatchDocumentType } from '../entities/batch-document.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Species } from '../../species/entities/species.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { CodeGeneratorService } from '../../database/services/code-generator.service';

@Injectable()
@CommandHandler(CreateBatchCommand)
export class CreateBatchHandler implements ICommandHandler<CreateBatchCommand, Batch> {
  private readonly logger = new Logger(CreateBatchHandler.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(BatchDocument)
    private readonly documentRepository: Repository<BatchDocument>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    private readonly codeGenerator: CodeGeneratorService,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: CreateBatchCommand): Promise<Batch> {
    const { tenantId, payload, createdBy } = command;

    // Species kontrolü
    const species = await this.speciesRepository.findOne({
      where: { id: payload.speciesId, tenantId, isActive: true, isDeleted: false },
    });

    if (!species) {
      throw new BadRequestException(`Species ${payload.speciesId} bulunamadı veya aktif değil`);
    }

    // Batch numarası oluştur
    const generatedCode = payload.batchNumber ? null : await this.codeGenerator.generateCode({
      prefix: 'B',
      tenantId,
      entityType: 'Batch',
    });
    const batchNumber = payload.batchNumber || generatedCode?.code || `B-${new Date().getFullYear()}-${Date.now()}`;

    // Başlangıç biomass hesapla
    const initialBiomass = (payload.initialQuantity * payload.initialAvgWeightG) / 1000;

    // Target FCR - tür bazlı veya kullanıcı tanımlı
    const targetFCR = payload.targetFCR || species.growthParameters?.targetFCR || 1.2;

    // Expected harvest date hesapla
    let expectedHarvestDate = payload.expectedHarvestDate;
    if (!expectedHarvestDate && species.harvestDaysPerInputType) {
      const inputTypeKey = payload.inputType.toLowerCase().replace('_', '') as keyof typeof species.harvestDaysPerInputType;
      const harvestDays = species.harvestDaysPerInputType[inputTypeKey];
      if (harvestDays) {
        expectedHarvestDate = new Date(payload.stockedAt);
        expectedHarvestDate.setDate(expectedHarvestDate.getDate() + harvestDays);
      }
    }

    // Batch entity oluştur
    const batch = this.batchRepository.create({
      tenantId,
      batchNumber,
      name: payload.name,
      description: payload.description,
      speciesId: payload.speciesId,
      strain: payload.strain,
      inputType: payload.inputType,
      initialQuantity: payload.initialQuantity,
      currentQuantity: payload.initialQuantity,
      totalMortality: 0,
      cullCount: 0,
      totalFeedConsumed: 0,
      totalFeedCost: 0,
      stockedAt: payload.stockedAt,
      expectedHarvestDate,
      supplierId: payload.supplierId,
      supplierBatchNumber: payload.supplierBatchNumber,
      purchaseCost: payload.purchaseCost,
      currency: payload.currency || 'TRY',
      arrivalMethod: payload.arrivalMethod,
      status: BatchStatus.QUARANTINE,
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
        isUserOverride: !!payload.targetFCR,
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
          target: species.growthParameters?.avgDailyGrowth || 0,
          variancePercent: 0,
        },
        daysInProduction: 0,
        projections: {
          harvestDate: expectedHarvestDate,
          harvestWeight: species.growthParameters?.avgHarvestWeight,
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

    // Save health certificates
    if (payload.healthCertificates && payload.healthCertificates.length > 0) {
      const healthCertDocs = payload.healthCertificates.map(doc =>
        this.documentRepository.create({
          tenantId,
          batchId: savedBatch.id,
          documentType: BatchDocumentType.HEALTH_CERTIFICATE,
          documentName: doc.documentName,
          documentNumber: doc.documentNumber,
          storagePath: doc.storagePath,
          storageUrl: doc.storageUrl,
          originalFilename: doc.originalFilename,
          mimeType: doc.mimeType,
          fileSize: doc.fileSize,
          issueDate: doc.issueDate ? new Date(doc.issueDate) : undefined,
          expiryDate: doc.expiryDate ? new Date(doc.expiryDate) : undefined,
          issuingAuthority: doc.issuingAuthority,
          notes: doc.notes,
          isActive: true,
          createdBy,
        })
      );
      await this.documentRepository.save(healthCertDocs);
    }

    // Save import documents
    if (payload.importDocuments && payload.importDocuments.length > 0) {
      const importDocs = payload.importDocuments.map(doc =>
        this.documentRepository.create({
          tenantId,
          batchId: savedBatch.id,
          documentType: BatchDocumentType.IMPORT_DOCUMENT,
          documentName: doc.documentName,
          documentNumber: doc.documentNumber,
          storagePath: doc.storagePath,
          storageUrl: doc.storageUrl,
          originalFilename: doc.originalFilename,
          mimeType: doc.mimeType,
          fileSize: doc.fileSize,
          issueDate: doc.issueDate ? new Date(doc.issueDate) : undefined,
          expiryDate: doc.expiryDate ? new Date(doc.expiryDate) : undefined,
          issuingAuthority: doc.issuingAuthority,
          notes: doc.notes,
          isActive: true,
          createdBy,
        })
      );
      await this.documentRepository.save(importDocs);
    }

    // Process initial locations and create TankBatch records
    if (payload.initialLocations && payload.initialLocations.length > 0) {
      this.logger.log(`Processing ${payload.initialLocations.length} initial location(s) for batch ${savedBatch.batchNumber}`);

      for (const location of payload.initialLocations) {
        const tankId = location.tankId || location.pondId;
        if (!tankId) {
          this.logger.warn('Skipping location without tankId or pondId');
          continue;
        }

        // Find the equipment (tank/pond/cage)
        const equipment = await this.equipmentRepository.findOne({
          where: { id: tankId, tenantId },
          relations: ['equipmentType'],
        });

        if (!equipment) {
          this.logger.warn(`Equipment ${tankId} not found, skipping allocation`);
          continue;
        }

        // Calculate avg weight from biomass and quantity
        const avgWeightG = location.quantity > 0
          ? (location.biomass * 1000) / location.quantity
          : payload.initialAvgWeightG;

        // Check if TankBatch already exists for this equipment
        let tankBatch = await this.tankBatchRepository.findOne({
          where: { tankId, tenantId },
        });

        // Calculate density if equipment has volume
        const specs = equipment.specifications as Record<string, unknown> | undefined;
        const tankVolume = Number(specs?.waterVolume || specs?.effectiveVolume || specs?.volume || 0);
        const density = tankVolume > 0 ? location.biomass / tankVolume : 0;

        // Calculate capacity usage
        const maxBiomass = Number(specs?.maxBiomass || 0);
        const capacityUsedPercent = maxBiomass > 0 ? (location.biomass / maxBiomass) * 100 : 0;
        const isOverCapacity = capacityUsedPercent > 100;

        if (tankBatch) {
          // Update existing TankBatch (mixed batch scenario)
          tankBatch.isMixedBatch = true;
          tankBatch.totalQuantity += location.quantity;
          tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) + location.biomass;
          tankBatch.avgWeightG = tankBatch.totalQuantity > 0
            ? (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity
            : avgWeightG;
          tankBatch.densityKgM3 = density;
          tankBatch.capacityUsedPercent = capacityUsedPercent;
          tankBatch.isOverCapacity = isOverCapacity;

          // Add to batch details
          const batchDetails = tankBatch.batchDetails || [];
          batchDetails.push({
            batchId: savedBatch.id,
            batchNumber: savedBatch.batchNumber,
            quantity: location.quantity,
            avgWeightG: avgWeightG,
            biomassKg: location.biomass,
            percentageOfTank: (location.biomass / Number(tankBatch.totalBiomassKg)) * 100,
          });
          tankBatch.batchDetails = batchDetails;

          this.logger.log(`Updated existing TankBatch for equipment ${equipment.code} (mixed batch)`);
        } else {
          // Create new TankBatch
          tankBatch = this.tankBatchRepository.create({
            tenantId,
            tankId,
            tankName: equipment.name,
            tankCode: equipment.code,
            primaryBatchId: savedBatch.id,
            primaryBatchNumber: savedBatch.batchNumber,
            totalQuantity: location.quantity,
            currentQuantity: location.quantity,
            avgWeightG: avgWeightG,
            totalBiomassKg: location.biomass,
            currentBiomassKg: location.biomass,
            densityKgM3: density,
            capacityUsedPercent: capacityUsedPercent,
            isOverCapacity: isOverCapacity,
            isMixedBatch: false,
          });

          this.logger.log(`Created new TankBatch for equipment ${equipment.code}`);
        }

        await this.tankBatchRepository.save(tankBatch);

        // Update equipment's currentBiomass and currentCount
        await this.equipmentRepository.update(tankId, {
          currentBiomass: Number(tankBatch.totalBiomassKg),
          currentCount: tankBatch.totalQuantity,
        });

        this.logger.log(`Allocated ${location.quantity} fish (${location.biomass} kg) to ${equipment.code}`);
      }
    }

    // Domain event yayınla
    // await this.eventBus.publish(new BatchCreatedEvent({
    //   tenantId,
    //   batchId: savedBatch.id,
    //   batchNumber: savedBatch.batchNumber,
    //   speciesId: savedBatch.speciesId,
    //   initialQuantity: savedBatch.initialQuantity,
    //   createdBy,
    // }));

    return savedBatch;
  }
}
