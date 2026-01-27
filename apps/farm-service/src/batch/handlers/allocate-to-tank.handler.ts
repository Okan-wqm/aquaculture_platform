/**
 * AllocateToTankHandler
 *
 * AllocateToTankCommand'ı işler ve batch'i tank'a dağıtır.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { AllocateToTankCommand, AllocationType } from '../commands/allocate-to-tank.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { TankAllocation } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment, TankSpecifications, EquipmentStatus } from '../../equipment/entities/equipment.entity';

@Injectable()
@CommandHandler(AllocateToTankCommand)
export class AllocateToTankHandler implements ICommandHandler<AllocateToTankCommand, TankAllocation> {
  private readonly logger = new Logger(AllocateToTankHandler.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankAllocation)
    private readonly allocationRepository: Repository<TankAllocation>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(command: AllocateToTankCommand): Promise<TankAllocation> {
    const { tenantId, batchId, payload, allocatedBy } = command;

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Equipment (Tank/Pond/Cage) bul
    const equipment = await this.equipmentRepository.findOne({
      where: { id: payload.tankId, tenantId, isActive: true, isDeleted: false },
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment ${payload.tankId} bulunamadı`);
    }

    // Equipment durumu kontrolü
    const allowedStatuses = [
      EquipmentStatus.OPERATIONAL,
      EquipmentStatus.ACTIVE,
      EquipmentStatus.PREPARING,
      EquipmentStatus.FALLOW,
      EquipmentStatus.STANDBY,
    ];
    if (!allowedStatuses.includes(equipment.status)) {
      throw new BadRequestException(
        `Equipment ${equipment.code} durumu (${equipment.status}) stoklama için uygun değil`
      );
    }

    // Specifications'dan kapasite bilgilerini al
    const specs = equipment.specifications as TankSpecifications | undefined;
    const maxBiomass = specs?.maxBiomass || 0;
    const maxDensity = specs?.maxDensity || 30;
    const volume = equipment.volume || specs?.volume || 0;

    // Kapasite kontrolü - sadece uyarı, bloklama yok
    const biomassKg = (payload.quantity * payload.avgWeightG) / 1000;
    const currentBiomass = equipment.currentBiomass || 0;
    const availableCapacity = maxBiomass - currentBiomass;

    if (biomassKg > availableCapacity) {
      this.logger.warn(
        `Equipment ${equipment.code} capacity exceeded. Adding biomass: ${biomassKg.toFixed(2)} kg, ` +
        `Available capacity: ${availableCapacity.toFixed(2)} kg. Proceeding anyway.`
      );
    }

    const effectiveVolume = volume;
    const densityKgM3 = effectiveVolume ? biomassKg / Number(effectiveVolume) : 0;

    // Allocation kaydı oluştur
    const allocation = this.allocationRepository.create({
      tenantId,
      batchId,
      tankId: payload.tankId,
      allocationType: payload.allocationType as AllocationType,
      allocationDate: payload.allocatedAt || new Date(),
      quantity: payload.quantity,
      avgWeightG: payload.avgWeightG,
      biomassKg,
      densityKgM3,
      // Denormalized fields
      batchNumber: batch.batchNumber,
      tankCode: equipment.code,
      tankName: equipment.name,
      allocatedBy,
      notes: payload.notes,
      isDeleted: false,
    });

    const savedAllocation = await this.allocationRepository.save(allocation);

    // TankBatch güncelle veya oluştur
    let tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.tankId },
    });

    if (!tankBatch) {
      tankBatch = this.tankBatchRepository.create({
        tenantId,
        tankId: payload.tankId,
        primaryBatchId: batchId,
        tankCode: equipment.code,
        tankName: equipment.name,
        primaryBatchNumber: batch.batchNumber,
        totalQuantity: 0,
        totalBiomassKg: 0,
        avgWeightG: 0,
        densityKgM3: 0,
        isMixedBatch: false,
        isOverCapacity: false,
      });
    }

    // Mevcut batch details
    const batchDetails = tankBatch.batchDetails || [];
    const existingBatchIndex = batchDetails.findIndex(b => b.batchId === batchId);

    if (existingBatchIndex >= 0 && batchDetails[existingBatchIndex]) {
      // Mevcut batch'i güncelle
      const existingBatch = batchDetails[existingBatchIndex];
      existingBatch.quantity += payload.quantity;
      existingBatch.biomassKg += biomassKg;
      existingBatch.avgWeightG = payload.avgWeightG;
    } else {
      // Yeni batch ekle
      batchDetails.push({
        batchId,
        batchNumber: batch.batchNumber,
        quantity: payload.quantity,
        avgWeightG: payload.avgWeightG,
        biomassKg,
        percentageOfTank: 0, // Sonra hesaplanacak
      });
    }

    // Totalleri hesapla
    tankBatch.totalQuantity = batchDetails.reduce((sum, b) => sum + b.quantity, 0);
    tankBatch.totalBiomassKg = batchDetails.reduce((sum, b) => sum + b.biomassKg, 0);
    tankBatch.avgWeightG = tankBatch.totalQuantity > 0
      ? (tankBatch.totalBiomassKg * 1000) / tankBatch.totalQuantity
      : 0;
    tankBatch.densityKgM3 = effectiveVolume
      ? tankBatch.totalBiomassKg / Number(effectiveVolume)
      : 0;

    // Yüzdeleri hesapla
    for (const detail of batchDetails) {
      detail.percentageOfTank = tankBatch.totalQuantity > 0
        ? (detail.quantity / tankBatch.totalQuantity) * 100
        : 0;
    }

    tankBatch.isMixedBatch = batchDetails.length > 1;
    tankBatch.batchDetails = batchDetails.length > 1 ? batchDetails : undefined;
    tankBatch.primaryBatchId = batchDetails[0]?.batchId || batchId;
    tankBatch.primaryBatchNumber = batchDetails[0]?.batchNumber || batch.batchNumber;

    // Kapasite kontrolü
    tankBatch.isOverCapacity = tankBatch.densityKgM3 > maxDensity;
    tankBatch.capacityUsedPercent = maxDensity > 0 ? (tankBatch.densityKgM3 / maxDensity) * 100 : 0;

    await this.tankBatchRepository.save(tankBatch);

    // Equipment güncelle
    equipment.currentBiomass = tankBatch.totalBiomassKg;
    equipment.currentCount = tankBatch.totalQuantity;
    if (equipment.status === EquipmentStatus.PREPARING || equipment.status === EquipmentStatus.FALLOW) {
      equipment.status = EquipmentStatus.ACTIVE;
    }
    await this.equipmentRepository.save(equipment);

    // Batch status güncelle (ilk stoklama ise)
    if (batch.status === BatchStatus.QUARANTINE && payload.allocationType === AllocationType.INITIAL_STOCKING) {
      batch.status = BatchStatus.ACTIVE;
      batch.statusChangedAt = new Date();
      await this.batchRepository.save(batch);
    }

    return savedAllocation;
  }
}
