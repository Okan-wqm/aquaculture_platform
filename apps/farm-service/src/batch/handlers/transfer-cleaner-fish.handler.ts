/**
 * TransferCleanerFishHandler
 *
 * TransferCleanerFishCommand'ı işler ve cleaner fish'i bir tanktan başka bir tanka transfer eder.
 *
 * @module Batch/Handlers
 */
import { Injectable, BadRequestException, NotFoundException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { TransferCleanerFishCommand } from '../commands/transfer-cleaner-fish.command';
import { Batch, BatchType } from '../entities/batch.entity';
import { TankBatch, CleanerFishDetail } from '../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { Species } from '../../species/entities/species.entity';

@Injectable()
@CommandHandler(TransferCleanerFishCommand)
export class TransferCleanerFishHandler implements ICommandHandler<TransferCleanerFishCommand, Batch> {
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

  async execute(command: TransferCleanerFishCommand): Promise<Batch> {
    const { tenantId, payload, transferredBy } = command;

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

    // Kaynak ve hedef tank aynı olmamalı
    if (payload.sourceTankId === payload.destinationTankId) {
      throw new BadRequestException('Kaynak ve hedef tank aynı olamaz');
    }

    // Kaynak tank'ı bul (Equipment entity)
    const sourceTank = await this.equipmentRepository.findOne({
      where: { id: payload.sourceTankId, tenantId, isActive: true },
    });

    if (!sourceTank) {
      throw new NotFoundException(`Kaynak tank ${payload.sourceTankId} bulunamadı`);
    }

    // Hedef tank'ı bul (Equipment entity)
    const destTank = await this.equipmentRepository.findOne({
      where: { id: payload.destinationTankId, tenantId, isActive: true },
    });

    if (!destTank) {
      throw new NotFoundException(`Hedef tank ${payload.destinationTankId} bulunamadı`);
    }

    // Kaynak TankBatch'i bul
    const sourceTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.sourceTankId },
    });

    if (!sourceTankBatch) {
      throw new NotFoundException(`Kaynak tank ${payload.sourceTankId} için TankBatch kaydı bulunamadı`);
    }

    // Kaynak tankta bu batch var mı kontrol et
    const sourceDetails = sourceTankBatch.cleanerFishDetails || [];
    const sourceBatchIndex = sourceDetails.findIndex(
      (d) => d.batchId === cleanerBatch.id
    );

    if (sourceBatchIndex < 0) {
      throw new BadRequestException(
        `Cleaner batch ${cleanerBatch.batchNumber} kaynak tankta bulunmuyor`
      );
    }

    const sourceBatchDetail = sourceDetails[sourceBatchIndex]!;

    // Miktar kontrolü
    if (payload.quantity > sourceBatchDetail.quantity) {
      throw new BadRequestException(
        `Transfer miktarı (${payload.quantity}) kaynak tanktaki cleaner fish miktarından (${sourceBatchDetail.quantity}) fazla olamaz`
      );
    }

    // Species bilgisini al
    const species = await this.speciesRepository.findOne({
      where: { id: cleanerBatch.speciesId, tenantId },
    });

    const speciesName = species?.commonName || 'Unknown Cleaner Fish';

    // Biomass hesapla
    const avgWeightG = sourceBatchDetail.avgWeightG;
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // --- KAYNAK TANK GÜNCELLE ---

    // Pre-operation state kaydet (source)
    const sourcePreOperationState = {
      quantity: sourceTankBatch.cleanerFishQuantity || 0,
      biomassKg: Number(sourceTankBatch.cleanerFishBiomassKg || 0),
      densityKgM3: Number(sourceTankBatch.densityKgM3 || 0),
    };

    // Kaynak tanktan düşür
    sourceBatchDetail.quantity -= payload.quantity;
    sourceBatchDetail.biomassKg -= biomassKg;

    if (sourceBatchDetail.quantity <= 0) {
      sourceDetails.splice(sourceBatchIndex, 1);
    } else {
      sourceDetails[sourceBatchIndex] = sourceBatchDetail;
    }

    sourceTankBatch.cleanerFishDetails = sourceDetails;
    sourceTankBatch.cleanerFishQuantity = Math.max(0, (sourceTankBatch.cleanerFishQuantity || 0) - payload.quantity);
    sourceTankBatch.cleanerFishBiomassKg = Math.max(0, Number(sourceTankBatch.cleanerFishBiomassKg || 0) - biomassKg);

    // Yoğunluk güncelle
    const sourceVolume = sourceTank.volume || 0;
    if (sourceVolume > 0) {
      const totalBiomass = Number(sourceTankBatch.totalBiomassKg || 0) + Number(sourceTankBatch.cleanerFishBiomassKg);
      sourceTankBatch.densityKgM3 = totalBiomass / Number(sourceVolume);
    }

    await this.tankBatchRepository.save(sourceTankBatch);

    // --- HEDEF TANK GÜNCELLE ---

    // Hedef TankBatch'i bul veya oluştur
    let destTankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.destinationTankId },
    });

    if (!destTankBatch) {
      destTankBatch = this.tankBatchRepository.create({
        tenantId,
        tankId: payload.destinationTankId,
        tankName: destTank.name,
        tankCode: destTank.code,
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

    // Pre-operation state kaydet (destination)
    const destPreOperationState = {
      quantity: destTankBatch.cleanerFishQuantity || 0,
      biomassKg: Number(destTankBatch.cleanerFishBiomassKg || 0),
      densityKgM3: Number(destTankBatch.densityKgM3 || 0),
    };

    // Hedef tanka ekle
    const destDetails = destTankBatch.cleanerFishDetails || [];
    const destBatchIndex = destDetails.findIndex(
      (d) => d.batchId === cleanerBatch.id
    );

    if (destBatchIndex >= 0) {
      // Mevcut kayda ekle
      const destDetail = destDetails[destBatchIndex]!;
      destDetail.quantity += payload.quantity;
      destDetail.biomassKg += biomassKg;
      // initialQuantity'yi de güncelle
      destDetail.initialQuantity = (destDetail.initialQuantity || 0) + payload.quantity;
      // Mortality rate yeniden hesapla
      if (destDetail.totalMortality && destDetail.initialQuantity > 0) {
        destDetail.mortalityRate = (destDetail.totalMortality / destDetail.initialQuantity) * 100;
      }
    } else {
      // Yeni kayıt oluştur
      const newDetail: CleanerFishDetail = {
        batchId: cleanerBatch.id,
        batchNumber: cleanerBatch.batchNumber,
        speciesId: cleanerBatch.speciesId,
        speciesName,
        quantity: payload.quantity,
        initialQuantity: payload.quantity,  // Transfer ilk yerleşim olarak sayılır
        avgWeightG,
        biomassKg,
        sourceType: cleanerBatch.sourceType as 'farmed' | 'wild_caught',
        deployedAt: payload.transferredAt,
        totalMortality: 0,                   // Yeni tank'ta mortality 0'dan başlar
        mortalityRate: 0,
      };
      destDetails.push(newDetail);
    }

    destTankBatch.cleanerFishDetails = destDetails;
    destTankBatch.cleanerFishQuantity = (destTankBatch.cleanerFishQuantity || 0) + payload.quantity;
    destTankBatch.cleanerFishBiomassKg = Number(destTankBatch.cleanerFishBiomassKg || 0) + biomassKg;

    // Yoğunluk güncelle
    const destVolume = destTank.volume || 0;
    if (destVolume > 0) {
      const totalBiomass = Number(destTankBatch.totalBiomassKg || 0) + Number(destTankBatch.cleanerFishBiomassKg);
      destTankBatch.densityKgM3 = totalBiomass / Number(destVolume);
    }

    await this.tankBatchRepository.save(destTankBatch);

    // --- TRANSFER OUT OPERASYONU ---
    const transferOutOp = this.operationRepository.create({
      tenantId,
      tankId: payload.sourceTankId,
      tankName: sourceTank.name,
      tankCode: sourceTank.code,
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      operationType: OperationType.CLEANER_TRANSFER_OUT,
      operationDate: payload.transferredAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
      destinationTankId: payload.destinationTankId,
      destinationTankName: destTank.name,
      transferReason: payload.reason,
      isCleanerFishOperation: true,
      cleanerSpeciesName: speciesName,
      cleanerBatchId: cleanerBatch.id,
      preOperationState: sourcePreOperationState,
      postOperationState: {
        quantity: sourceTankBatch.cleanerFishQuantity,
        biomassKg: Number(sourceTankBatch.cleanerFishBiomassKg),
        densityKgM3: Number(sourceTankBatch.densityKgM3),
      },
      notes: payload.notes,
      performedBy: transferredBy,
      isDeleted: false,
    });

    await this.operationRepository.save(transferOutOp);

    // --- TRANSFER IN OPERASYONU ---
    const transferInOp = this.operationRepository.create({
      tenantId,
      tankId: payload.destinationTankId,
      tankName: destTank.name,
      tankCode: destTank.code,
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      operationType: OperationType.CLEANER_TRANSFER_IN,
      operationDate: payload.transferredAt,
      quantity: payload.quantity,
      avgWeightG,
      biomassKg,
      sourceTankId: payload.sourceTankId,
      transferReason: payload.reason,
      isCleanerFishOperation: true,
      cleanerSpeciesName: speciesName,
      cleanerBatchId: cleanerBatch.id,
      preOperationState: destPreOperationState,
      postOperationState: {
        quantity: destTankBatch.cleanerFishQuantity,
        biomassKg: Number(destTankBatch.cleanerFishBiomassKg),
        densityKgM3: Number(destTankBatch.densityKgM3),
      },
      notes: payload.notes,
      performedBy: transferredBy,
      isDeleted: false,
    });

    await this.operationRepository.save(transferInOp);

    // Batch güncelle
    cleanerBatch.updatedBy = transferredBy;
    await this.batchRepository.save(cleanerBatch);

    return cleanerBatch;
  }
}
