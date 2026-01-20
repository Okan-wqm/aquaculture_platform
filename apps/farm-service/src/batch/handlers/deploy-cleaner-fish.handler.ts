/**
 * DeployCleanerFishHandler
 *
 * DeployCleanerFishCommand'ı işler ve cleaner fish'i bir tanka yerleştirir.
 *
 * @module Batch/Handlers
 */
import { Injectable, BadRequestException, NotFoundException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { DeployCleanerFishCommand } from '../commands/deploy-cleaner-fish.command';
import { Batch, BatchType } from '../entities/batch.entity';
import { TankBatch, CleanerFishDetail } from '../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Species } from '../../species/entities/species.entity';

@Injectable()
@CommandHandler(DeployCleanerFishCommand)
export class DeployCleanerFishHandler implements ICommandHandler<DeployCleanerFishCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: DeployCleanerFishCommand): Promise<Batch> {
    const { tenantId, payload, deployedBy } = command;

    // Cleaner batch'i bul
    const cleanerBatch = await this.batchRepository.findOne({
      where: { id: payload.cleanerBatchId, tenantId, isActive: true },
    });

    if (!cleanerBatch) {
      throw new NotFoundException(`Cleaner batch ${payload.cleanerBatchId} bulunamadı`);
    }

    if (cleanerBatch.batchType !== BatchType.CLEANER_FISH) {
      throw new BadRequestException(
        `Batch ${cleanerBatch.batchNumber} bir cleaner fish batch'i değil`
      );
    }

    // Miktar kontrolü
    if (payload.quantity > cleanerBatch.currentQuantity) {
      throw new BadRequestException(
        `Deploy miktarı (${payload.quantity}) mevcut miktardan (${cleanerBatch.currentQuantity}) fazla olamaz`
      );
    }

    // Hedef tank'ı bul (Equipment entity)
    const targetTank = await this.equipmentRepository.findOne({
      where: { id: payload.targetTankId, tenantId, isActive: true },
    });

    if (!targetTank) {
      throw new NotFoundException(`Tank ${payload.targetTankId} bulunamadı`);
    }

    // Species bilgisini al
    const species = await this.speciesRepository.findOne({
      where: { id: cleanerBatch.speciesId, tenantId },
    });

    const speciesName = species?.commonName || 'Unknown Cleaner Fish';

    // Ağırlık ve biomass hesapla
    const avgWeightG = payload.avgWeightG || cleanerBatch.getCurrentAvgWeight();
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // TankBatch'i bul veya oluştur
    let tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.targetTankId },
    });

    if (!tankBatch) {
      // TankBatch yoksa oluştur (sadece cleaner fish ile)
      tankBatch = this.tankBatchRepository.create({
        tenantId,
        tankId: payload.targetTankId,
        tankName: targetTank.name,
        tankCode: targetTank.code,
        totalQuantity: 0,
        totalBiomassKg: 0,
        avgWeightG: 0,
        densityKgM3: 0,
        cleanerFishQuantity: 0,
        cleanerFishBiomassKg: 0,
        cleanerFishDetails: [],
        isMixedBatch: false,
        isOverCapacity: false,
      });
    }

    // Pre-operation state kaydet
    const preOperationState = {
      quantity: tankBatch.cleanerFishQuantity || 0,
      biomassKg: Number(tankBatch.cleanerFishBiomassKg || 0),
      densityKgM3: Number(tankBatch.densityKgM3 || 0),
    };

    // Cleaner fish detaylarını güncelle
    const existingDetails = tankBatch.cleanerFishDetails || [];
    const existingDetailIndex = existingDetails.findIndex(
      (d) => d.batchId === cleanerBatch.id
    );

    const newDetail: CleanerFishDetail = {
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      speciesId: cleanerBatch.speciesId,
      speciesName,
      quantity: payload.quantity,
      initialQuantity: payload.quantity,  // İlk deploy miktarını kaydet
      avgWeightG,
      biomassKg,
      sourceType: cleanerBatch.sourceType as 'farmed' | 'wild_caught',
      deployedAt: payload.deployedAt,
      totalMortality: 0,                   // Başlangıçta mortality 0
      mortalityRate: 0,
    };

    if (existingDetailIndex >= 0) {
      // Mevcut batch'e ekle
      const existingDetail = existingDetails[existingDetailIndex]!;
      existingDetail.quantity += payload.quantity;
      existingDetail.biomassKg += biomassKg;
      // initialQuantity'yi de güncelle (ek deployment)
      existingDetail.initialQuantity = (existingDetail.initialQuantity || 0) + payload.quantity;
      // Mortality rate yeniden hesapla (eğer mortality varsa)
      if (existingDetail.totalMortality && existingDetail.initialQuantity > 0) {
        existingDetail.mortalityRate = (existingDetail.totalMortality / existingDetail.initialQuantity) * 100;
      }
    } else {
      // Yeni kayıt ekle
      existingDetails.push(newDetail);
    }

    tankBatch.cleanerFishDetails = existingDetails;
    tankBatch.cleanerFishQuantity = (tankBatch.cleanerFishQuantity || 0) + payload.quantity;
    tankBatch.cleanerFishBiomassKg = Number(tankBatch.cleanerFishBiomassKg || 0) + biomassKg;

    // Tank yoğunluğunu güncelle
    const tankVolume = targetTank.volume || 0;
    if (tankVolume > 0) {
      const totalBiomass = Number(tankBatch.totalBiomassKg || 0) + Number(tankBatch.cleanerFishBiomassKg);
      tankBatch.densityKgM3 = totalBiomass / Number(tankVolume);
    }

    await this.tankBatchRepository.save(tankBatch);

    // Cleaner batch miktarını düşür
    cleanerBatch.currentQuantity -= payload.quantity;
    cleanerBatch.updatedBy = deployedBy;
    await this.batchRepository.save(cleanerBatch);

    // TankOperation kaydı oluştur
    const operation = this.operationRepository.create({
      tenantId,
      tankId: payload.targetTankId,
      tankName: targetTank.name,
      tankCode: targetTank.code,
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      operationType: OperationType.CLEANER_DEPLOYMENT,
      operationDate: payload.deployedAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
      isCleanerFishOperation: true,
      cleanerSpeciesName: speciesName,
      cleanerBatchId: cleanerBatch.id,
      preOperationState,
      postOperationState: {
        quantity: tankBatch.cleanerFishQuantity,
        biomassKg: Number(tankBatch.cleanerFishBiomassKg),
        densityKgM3: Number(tankBatch.densityKgM3),
      },
      notes: payload.notes,
      performedBy: deployedBy,
      isDeleted: false,
    });

    await this.operationRepository.save(operation);

    return cleanerBatch;
  }
}
