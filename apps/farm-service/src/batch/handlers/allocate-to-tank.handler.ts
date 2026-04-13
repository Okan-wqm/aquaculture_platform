/**
 * AllocateToTankHandler
 *
 * AllocateToTankCommand'ı işler ve batch'i tank'a dağıtır.
 *
 * SECURITY FIX: Transaction protection added to prevent race conditions
 * when multiple concurrent requests attempt to allocate to the same tank.
 *
 * Phase D refactor: DomainEventPublisher → OutboxPublisher (pre-commit,
 * transactional). BatchAllocatedToTank events now ship with at-least-once
 * delivery guarantee. The command's AllocationType enum is mapped to the
 * narrower contract literal (`'initial' | 'transfer_in' | 'split'`) — the
 * mismatch was silent before because DomainEventPublisher accepted any
 * `Record<string, unknown>`.
 *
 * @module Batch/Handlers
 */
import { randomUUID } from 'crypto';
import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import type { BatchAllocatedToTankEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { AllocateToTankCommand, AllocationType } from '../commands/allocate-to-tank.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { TankAllocation } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Equipment, TankSpecifications, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { Role, hasAnyRole } from '@aquaculture/backend-common';

/**
 * Map the command's AllocationType enum to the BatchAllocatedToTankEvent
 * contract's narrower literal union. The contract intentionally restricts
 * to the three values that mean "fish arrived in this tank" — TRANSFER_OUT
 * / GRADING / HARVEST do not produce an "allocated to tank" event
 * semantically and therefore throw rather than silently remapping.
 */
function toAllocationTypeCode(
  input: AllocationType,
): 'initial' | 'transfer_in' | 'split' {
  switch (input) {
    case AllocationType.INITIAL_STOCKING:
      return 'initial';
    case AllocationType.TRANSFER_IN:
      return 'transfer_in';
    case AllocationType.SPLIT:
      return 'split';
    case AllocationType.TRANSFER_OUT:
    case AllocationType.GRADING:
    case AllocationType.HARVEST:
      throw new BadRequestException(
        `AllocationType ${input} is not valid for AllocateToTankCommand — ` +
          `these operations have their own dedicated handlers and events.`,
      );
  }
}

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
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Execute tank allocation with transaction protection
   *
   * SECURITY FIX: All operations are wrapped in a SERIALIZABLE transaction
   * to prevent race conditions when concurrent requests attempt to allocate
   * to the same tank simultaneously.
   */
  async execute(command: AllocateToTankCommand): Promise<TankAllocation> {
    const { tenantId, batchId, payload, allocatedBy, userRoles } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Batch bul with pessimistic lock
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      // Equipment (Tank/Pond/Cage) bul with pessimistic lock
      const equipment = await queryRunner.manager.findOne(Equipment, {
        where: { id: payload.tankId, tenantId, isActive: true, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
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

      // LIFE-SAFETY: Hard capacity enforcement — reject over-capacity allocations.
      // Uses equipment.hasCapacityFor() which checks BOTH biomass limit AND density
      // limit against the equipment's specifications. Admin users can override with
      // mandatory audit trail logging.
      const biomassKg = (payload.quantity * payload.avgWeightG) / 1000;

      if (!equipment.hasCapacityFor(biomassKg)) {
        const isAdmin = userRoles.some(
          (r) => hasAnyRole(r as Role, [Role.SUPER_ADMIN, Role.TENANT_ADMIN]),
        );

        if (!isAdmin) {
          const currentBiomass = equipment.currentBiomass || 0;
          const availableCapacity = equipment.getAvailableCapacity();
          const effectiveVol = equipment.volume || 0;
          const projectedDensity = effectiveVol > 0
            ? (currentBiomass + biomassKg) / effectiveVol
            : 0;

          // LIFE-SAFETY: Block non-admin allocation that exceeds capacity or density.
          throw new BadRequestException(
            `Equipment ${equipment.code} kapasite/yogunluk asimi. ` +
            `Eklenen biyokütle: ${biomassKg.toFixed(2)} kg, ` +
            `Kullanilabilir kapasite: ${availableCapacity.toFixed(2)} kg, ` +
            `Projeksiyon yogunluk: ${projectedDensity.toFixed(2)} kg/m3, ` +
            `Maksimum yogunluk: ${maxDensity} kg/m3. Stoklama reddedildi.`,
          );
        }

        // SECURITY: Admin override — allow allocation but log for audit trail
        this.logger.warn(
          `ADMIN OVERRIDE: capacity/density limit exceeded for equipment ${equipment.code}. ` +
          `Batch ${batchId}, biomass ${biomassKg.toFixed(2)} kg, ` +
          `available ${equipment.getAvailableCapacity().toFixed(2)} kg. ` +
          `Overridden by ${allocatedBy}, tenant: ${tenantId}`,
        );
      }

      const effectiveVolume = volume;
      const currentBiomass = equipment.currentBiomass || 0;
      const densityKgM3 = effectiveVolume ? (currentBiomass + biomassKg) / Number(effectiveVolume) : 0;

      // Allocation kaydı oluştur
      const allocation = queryRunner.manager.create(TankAllocation, {
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

      const savedAllocation = await queryRunner.manager.save(allocation);

      // TankBatch güncelle veya oluştur with pessimistic lock
      let tankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.tankId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!tankBatch) {
        tankBatch = queryRunner.manager.create(TankBatch, {
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
          cleanerFishBiomassKg: 0,
          cleanerFishQuantity: 0,
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

      await queryRunner.manager.save(tankBatch);

      // Equipment güncelle
      equipment.currentBiomass = tankBatch.totalBiomassKg;
      equipment.currentCount = tankBatch.totalQuantity;
      if (equipment.status === EquipmentStatus.PREPARING || equipment.status === EquipmentStatus.FALLOW) {
        equipment.status = EquipmentStatus.ACTIVE;
      }
      await queryRunner.manager.save(equipment);

      // Batch status güncelle (ilk stoklama ise)
      if (batch.status === BatchStatus.QUARANTINE && payload.allocationType === AllocationType.INITIAL_STOCKING) {
        batch.status = BatchStatus.ACTIVE;
        batch.statusChangedAt = new Date();
        await queryRunner.manager.save(batch);
      }

      // Enqueue BatchAllocatedToTankEvent into the transactional outbox BEFORE commit.
      const allocationDate = payload.allocatedAt || new Date();
      const eventBiomassKg = (payload.quantity * (payload.avgWeightG ?? 0)) / 1000;
      const allocationEvent: BatchAllocatedToTankEvent = {
        ...createBaseEvent<BatchAllocatedToTankEvent>('BatchAllocatedToTank', tenantId, { aggregateId: batchId, aggregateType: 'Batch' }),
        userId: allocatedBy,
        batchId,
        tankId: payload.tankId,
        quantity: payload.quantity,
        biomassKg: eventBiomassKg,
        allocationType: toAllocationTypeCode(payload.allocationType as AllocationType),
        allocationDate,
      };
      await this.outboxPublisher.enqueue(allocationEvent, queryRunner.manager);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Batch ${batchId} allocated to tank ${payload.tankId} — ` +
        `qty=${payload.quantity}, type=${payload.allocationType}, tenant=${tenantId}`,
      );

      return savedAllocation;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
