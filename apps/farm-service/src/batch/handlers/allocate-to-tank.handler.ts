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
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Injectable, NotFoundException, BadRequestException, Logger, ConflictException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import type { BatchAllocatedToTankEvent } from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource } from 'typeorm';

import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
  defaultMobileCommandReceiptsForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Equipment, EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank, TankStatus } from '../../tank/entities/tank.entity';
import { TankCapacityService } from '../../tank/services/tank-capacity.service';
import { AllocateToTankCommand, AllocationType } from '../commands/allocate-to-tank.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { TankAllocation } from '../entities/tank-allocation.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { resolveSiteIdFromDepartment } from '../utils/tank-lookup.util';

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
    private readonly tankCapacityService: TankCapacityService,
    private readonly auditLogService: AuditLogService,
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
    private readonly farmStockProjection: FarmStockProjectionService =
      defaultFarmStockProjectionForDirectHandlerConstruction(),
    private readonly mobileCommandReceipts: MobileCommandReceiptService =
      defaultMobileCommandReceiptsForDirectHandlerConstruction(),
  ) {}

  /**
   * Execute tank allocation with transaction protection
   *
   * SECURITY FIX: All operations are wrapped in a SERIALIZABLE transaction
   * to prevent race conditions when concurrent requests attempt to allocate
   * to the same tank simultaneously.
   */
  async execute(command: AllocateToTankCommand): Promise<TankAllocation> {
    const { tenantId, batchId, payload, allocatedBy, userRoles, callerAssignedSiteIds } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope: command.mobileCommand,
        operationType: 'allocateBatchToTank',
        responseType: 'TankAllocation',
      });
      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(TankAllocation, {
              where: { id: receipt.responseId, tenantId, isDeleted: false },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      // Batch bul with pessimistic lock
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      // Equipment compatibility row or canonical Tank row bul with pessimistic lock
      let equipment = await queryRunner.manager.findOne(Equipment, {
        where: { id: payload.tankId, tenantId, isActive: true, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      let canonicalTank: Tank | null = null;

      if (!equipment) {
        canonicalTank = await queryRunner.manager.findOne(Tank, {
          where: { id: payload.tankId, tenantId, isActive: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (canonicalTank) {
          equipment = this.tankToCapacityEquipment(canonicalTank);
        }
      }

      if (!equipment) {
        throw new NotFoundException(`Tank ${payload.tankId} bulunamadı`);
      }

      // SEC-HIGH-051: object-level site authorization. The tank is already
      // loaded+locked above, so resolve its owning site from the known
      // departmentId (one Department lookup, no redundant tank re-lookup) and
      // assert the caller is assigned to it BEFORE any allocation write.
      // MODULE_MANAGER+ bypasses; an unassigned/unresolved site for a MODULE_USER
      // is DENIED. canonicalTank (legacy) carries departmentId; the adapted
      // Equipment may not, so prefer the canonical row's departmentId.
      const departmentId = canonicalTank?.departmentId ?? equipment.departmentId;
      const tankSiteId = await resolveSiteIdFromDepartment(queryRunner.manager, departmentId, tenantId);
      this.siteAuth.assertSiteAssignment({
        caller: { sub: allocatedBy, roles: userRoles, assignedSiteIds: callerAssignedSiteIds },
        siteId: tankSiteId,
      });

      // Existing biomass on the tank — pull the cleaner-fish component
      // from the tank_batches row (if any) so the capacity check can
      // account for mixed-use tanks (salmon + cleaner fish coexisting).
      const existingTankBatch = await queryRunner.manager.findOne(TankBatch, {
        where: { tenantId, tankId: payload.tankId },
      });

      // LIFE-SAFETY: Hard capacity enforcement with admin override.
      // Centralised in TankCapacityService — checks status, biomass and
      // density axes consistently across every handler that places fish
      // into a tank (allocate, transfer, deploy-cleaner-fish). Admin
      // users (SUPER_ADMIN / TENANT_ADMIN) may override with audit log.
      const biomassKg = (payload.quantity * payload.avgWeightG) / 1000;

      const capacity = this.tankCapacityService.enforce({
        mode: 'admin-override',
        equipment,
        existing: {
          salmonBiomassKg: Number(equipment.currentBiomass || 0),
          cleanerBiomassKg: Number(existingTankBatch?.cleanerFishBiomassKg || 0),
        },
        incomingBiomassKg: biomassKg,
        callerRoles: userRoles,
        callerUserId: allocatedBy,
      });

      const effectiveVolume = capacity.tankVolumeM3;
      const densityKgM3 = capacity.projectedDensityKgM3;

      // Allocation kaydı oluştur
      const allocation = queryRunner.manager.create(TankAllocation, {
        tenantId,
        batchId,
        tankId: payload.tankId,
        allocationType: payload.allocationType,
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

      // Kapasite bayrakları — TankCapacityService'den gelen kalkulasyonu
      // doğrudan TankBatch'e yaz. Admin-override alındıysa flag yine `true`
      // kaydedilir (audit trail için) ama throw edilmez.
      tankBatch.isOverCapacity = capacity.isOverCapacity;
      tankBatch.capacityUsedPercent = capacity.utilizationPercent;

      const savedTankBatch = await queryRunner.manager.save(tankBatch);

      // Phase 1.1: when an admin consciously overrode the capacity gate
      // we record a CAPACITY_BLOCKED row in farm_audit_logs. The write
      // goes through the same transactional manager so the audit row
      // commits or rolls back atomically with the allocation. The
      // service.enforce() call already logged a warn-level line; this
      // is the durable trail post-hoc analysis can query.
      if (capacity.isOverCapacity) {
        await this.auditLogService.logWithManager(queryRunner.manager, {
          tenantId,
          entityType: 'TankBatch',
          entityId: savedTankBatch.id,
          action: AuditAction.CAPACITY_BLOCKED,
          userId: allocatedBy,
          changes: {
            after: {
              tankId: payload.tankId,
              batchId,
              incomingBiomassKg: biomassKg,
              projectedBiomassKg: capacity.projectedBiomassKg,
              projectedDensityKgM3: capacity.projectedDensityKgM3,
              maxBiomassKg: capacity.maxBiomassKg,
              maxDensityKgM3: capacity.maxDensityKgM3,
              utilizationPercent: capacity.utilizationPercent,
              isOverBiomass: capacity.isOverBiomass,
              isOverDensity: capacity.isOverDensity,
              primaryBlockReason: capacity.primaryBlockReason,
            },
          },
          metadata: {
            source: 'AllocateToTankHandler',
          },
          summary:
            `Admin override: allocated ${biomassKg.toFixed(2)} kg into ` +
            `tank ${equipment.code ?? payload.tankId} despite ${capacity.primaryBlockReason} ` +
            `cap (${capacity.utilizationPercent.toFixed(1)}% utilization)`,
        });
      }

      // Canonical container güncelle
      if (canonicalTank) {
        canonicalTank.currentBiomass = tankBatch.totalBiomassKg;
        canonicalTank.currentCount = tankBatch.totalQuantity;
        if (canonicalTank.status === TankStatus.PREPARING || canonicalTank.status === TankStatus.FALLOW) {
          canonicalTank.status = TankStatus.ACTIVE;
          canonicalTank.statusChangedAt = new Date();
        }
        await queryRunner.manager.save(canonicalTank);
      } else {
        equipment.currentBiomass = tankBatch.totalBiomassKg;
        equipment.currentCount = tankBatch.totalQuantity;
        if (equipment.status === EquipmentStatus.PREPARING || equipment.status === EquipmentStatus.FALLOW) {
          equipment.status = EquipmentStatus.ACTIVE;
        }
        await queryRunner.manager.save(equipment);
      }

      // Batch status güncelle (ilk stoklama ise)
      if (batch.status === BatchStatus.QUARANTINE && payload.allocationType === AllocationType.INITIAL_STOCKING) {
        batch.status = BatchStatus.ACTIVE;
        batch.statusChangedAt = new Date();
        await queryRunner.manager.save(batch);
      }

      await this.farmStockProjection.refreshContainers(
        queryRunner.manager,
        tenantId,
        [payload.tankId],
      );

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
        allocationType: toAllocationTypeCode(payload.allocationType),
        allocationDate: toEventIso(allocationDate),
      };
      await this.outboxPublisher.enqueue(allocationEvent, queryRunner.manager);
      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'TankAllocation',
        responseId: savedAllocation.id,
        responsePayload: { id: savedAllocation.id },
      });

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

  private tankToCapacityEquipment(tank: Tank): Equipment {
    const equipment = new Equipment();
    equipment.id = tank.id;
    equipment.tenantId = tank.tenantId;
    equipment.name = tank.name;
    equipment.code = tank.code;
    equipment.status = this.mapTankStatusToEquipmentStatus(tank.status);
    equipment.isTank = true;
    equipment.isActive = tank.isActive;
    equipment.isDeleted = false;
    equipment.volume = Number(tank.volume);
    equipment.currentBiomass = Number(tank.currentBiomass);
    equipment.currentCount = tank.currentCount;
    equipment.specifications = {
      tankType: tank.tankType,
      material: tank.material,
      waterType: tank.waterType,
      dimensions: {
        diameter: tank.diameter,
        length: tank.length,
        width: tank.width,
        depth: tank.depth,
        waterDepth: tank.waterDepth,
        freeboard: tank.freeboard,
      },
      volume: Number(tank.volume),
      waterVolume: tank.waterVolume ? Number(tank.waterVolume) : undefined,
      maxBiomass: Number(tank.maxBiomass),
      maxDensity: Number(tank.maxDensity),
      waterFlow: tank.waterFlow,
      aeration: tank.aeration,
    };
    return equipment;
  }

  private mapTankStatusToEquipmentStatus(status: TankStatus): EquipmentStatus {
    const mapping: Record<TankStatus, EquipmentStatus> = {
      [TankStatus.ACTIVE]: EquipmentStatus.ACTIVE,
      [TankStatus.PREPARING]: EquipmentStatus.PREPARING,
      [TankStatus.CLEANING]: EquipmentStatus.CLEANING,
      [TankStatus.MAINTENANCE]: EquipmentStatus.MAINTENANCE,
      [TankStatus.HARVESTING]: EquipmentStatus.HARVESTING,
      [TankStatus.FALLOW]: EquipmentStatus.FALLOW,
      [TankStatus.QUARANTINE]: EquipmentStatus.QUARANTINE,
      [TankStatus.INACTIVE]: EquipmentStatus.OUT_OF_SERVICE,
    };
    return mapping[status] ?? EquipmentStatus.OPERATIONAL;
  }
}
