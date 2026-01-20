/**
 * RemoveCleanerFishHandler
 *
 * RemoveCleanerFishCommand'ı işler ve cleaner fish'i tanktan çıkarır.
 * Harvest, cycle sonu vb. durumlar için kullanılır (mortality değil).
 *
 * @module Batch/Handlers
 */
import { Injectable, BadRequestException, NotFoundException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { RemoveCleanerFishCommand } from '../commands/remove-cleaner-fish.command';
import { Batch, BatchType } from '../entities/batch.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Species } from '../../species/entities/species.entity';

@Injectable()
@CommandHandler(RemoveCleanerFishCommand)
export class RemoveCleanerFishHandler implements ICommandHandler<RemoveCleanerFishCommand, Batch> {
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

  async execute(command: RemoveCleanerFishCommand): Promise<Batch> {
    const { tenantId, payload, removedBy } = command;

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

    // Tank'ı bul (Equipment entity)
    const tank = await this.equipmentRepository.findOne({
      where: { id: payload.tankId, tenantId, isActive: true },
    });

    if (!tank) {
      throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
    }

    // TankBatch'i bul
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId: payload.tankId },
    });

    if (!tankBatch) {
      throw new NotFoundException(`Tank ${tank.name} için batch kaydı bulunamadı`);
    }

    // Bu batch'in tank'ta olup olmadığını kontrol et
    const existingDetails = tankBatch.cleanerFishDetails || [];
    const detailIndex = existingDetails.findIndex(
      (d) => d.batchId === cleanerBatch.id
    );

    if (detailIndex < 0) {
      throw new BadRequestException(
        `Batch ${cleanerBatch.batchNumber} bu tankta bulunmuyor`
      );
    }

    const existingDetail = existingDetails[detailIndex]!;

    // Miktar kontrolü
    if (payload.quantity > existingDetail.quantity) {
      throw new BadRequestException(
        `Çıkarma miktarı (${payload.quantity}) mevcut miktardan (${existingDetail.quantity}) fazla olamaz`
      );
    }

    // Species bilgisini al
    const species = await this.speciesRepository.findOne({
      where: { id: cleanerBatch.speciesId, tenantId },
    });

    const speciesName = species?.commonName || existingDetail.speciesName || 'Unknown Cleaner Fish';

    // Ağırlık ve biomass hesapla
    const avgWeightG = payload.avgWeightG || existingDetail.avgWeightG;
    const biomassKg = (payload.quantity * avgWeightG) / 1000;

    // Pre-operation state kaydet
    const preOperationState = {
      quantity: tankBatch.cleanerFishQuantity || 0,
      biomassKg: Number(tankBatch.cleanerFishBiomassKg || 0),
      densityKgM3: Number(tankBatch.densityKgM3 || 0),
    };

    // Cleaner fish detaylarını güncelle
    if (payload.quantity >= existingDetail.quantity) {
      // Tüm batch'i çıkar
      existingDetails.splice(detailIndex, 1);
    } else {
      // Kısmi çıkarma
      existingDetail.quantity -= payload.quantity;
      existingDetail.biomassKg = (existingDetail.quantity * existingDetail.avgWeightG) / 1000;
    }

    tankBatch.cleanerFishDetails = existingDetails;
    tankBatch.cleanerFishQuantity = Math.max(0, (tankBatch.cleanerFishQuantity || 0) - payload.quantity);
    tankBatch.cleanerFishBiomassKg = Math.max(0, Number(tankBatch.cleanerFishBiomassKg || 0) - biomassKg);

    // Tank yoğunluğunu güncelle
    const tankVolume = tank.volume || 0;
    if (tankVolume > 0) {
      const totalBiomass = Number(tankBatch.totalBiomassKg || 0) + Number(tankBatch.cleanerFishBiomassKg);
      tankBatch.densityKgM3 = totalBiomass / Number(tankVolume);
    }

    await this.tankBatchRepository.save(tankBatch);

    // Cleaner batch'i güncelle (relocation durumunda miktarı geri ekle)
    if (payload.reason === 'relocation') {
      cleanerBatch.currentQuantity += payload.quantity;
    }
    cleanerBatch.updatedBy = removedBy;
    await this.batchRepository.save(cleanerBatch);

    // TankOperation kaydı oluştur
    const removalNotes = payload.notes
      ? `Removal reason: ${payload.reason}. ${payload.notes}`
      : `Removal reason: ${payload.reason}`;

    const operation = this.operationRepository.create({
      tenantId,
      tankId: payload.tankId,
      tankName: tank.name,
      tankCode: tank.code,
      batchId: cleanerBatch.id,
      batchNumber: cleanerBatch.batchNumber,
      operationType: OperationType.CLEANER_REMOVAL,
      operationDate: payload.removedAt,
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
      notes: removalNotes,
      performedBy: removedBy,
      isDeleted: false,
    });

    await this.operationRepository.save(operation);

    return cleanerBatch;
  }
}
