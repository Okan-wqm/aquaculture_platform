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
import { numberOrUndefined, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ConflictException,
} from '@nestjs/common';
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
import { TankBatchService } from '../services/tank-batch.service';
import { TankStockingService } from '../services/tank-stocking.service';
import { resolveSiteIdFromDepartment } from '../utils/tank-lookup.util';

/**
 * Map the command's AllocationType enum to the BatchAllocatedToTankEvent
 * contract's narrower literal union. The contract intentionally restricts
 * to the three values that mean "fish arrived in this tank" — TRANSFER_OUT
 * / GRADING / HARVEST do not produce an "allocated to tank" event
 * semantically and therefore throw rather than silently remapping.
 */
function toAllocationTypeCode(input: AllocationType): 'initial' | 'transfer_in' | 'split' {
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
export class AllocateToTankHandler implements ICommandHandler<AllocateToTankCommand, Batch> {
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
    // SSoT writer for tank composition: batchDetails[] is the source of truth,
    // aggregates derived. Shared with transfer/mortality/cull so every stock
    // mutation updates a tank the same way (no divergent hand-written copies).
    private readonly tankBatchService: TankBatchService,
    private readonly tankStocking: TankStockingService,
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
    private readonly mobileCommandReceipts: MobileCommandReceiptService = defaultMobileCommandReceiptsForDirectHandlerConstruction(),
  ) {}

  /**
   * Execute tank allocation with transaction protection.
   *
   * SECURITY: every operation runs in a SERIALIZABLE transaction so concurrent
   * allocations to the same tank cannot interleave.
   *
   * INFRA-HIGH-174: this used to hand-roll `createQueryRunner()` +
   * `startTransaction('SERIALIZABLE')` because the canonical
   * `runInTenantTransaction` could not express an isolation level. The price was
   * that this handler — the one that moves fish — ran without the
   * transaction-local search_path pinning and the RLS-GUC assertion every other
   * farm handler gets, so stronger isolation was bought by giving up the
   * tenant-safety checks. The helper takes an isolation level now, so this path
   * keeps SERIALIZABLE and regains both, and inherits the bounded
   * serialization-failure retry it previously had none of.
   *
   * The retry is safe here because every write below goes through the passed
   * manager — the mobile-command receipt, the counters, the audit row and the
   * outbox enqueue all roll back with a failed attempt.
   */
  async execute(command: AllocateToTankCommand): Promise<Batch> {
    const { tenantId, batchId, payload, allocatedBy, userRoles, callerAssignedSiteIds } = command;

    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner) => {
        const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
          tableName: 'farm_mobile_command_receipts',
          tenantId,
          envelope: command.mobileCommand,
          operationType: 'allocateBatchToTank',
          responseType: 'Batch',
        });
        if (receipt.mode === 'replay') {
          const replayed = receipt.responseId
            ? await queryRunner.manager.findOne(Batch, {
                where: { id: receipt.responseId, tenantId, isActive: true },
              })
            : null;
          if (!replayed) {
            throw new ConflictException('Mobile command receipt response is no longer available');
          }
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

        // FARM-HIGH-323 / SEC-HIGH-167: the whole stocking sequence — lock the
        // container, authorize the site, decide capacity under that lock, write the
        // ledger row, apply the composition delta, update the container — lives in
        // TankStockingService so create-batch's initial stocking performs the
        // identical steps instead of a weaker copy of them.
        const stocked = await this.tankStocking.stockTank(queryRunner.manager, {
          tenantId,
          tankId: payload.tankId,
          batch: { id: batch.id, batchNumber: batch.batchNumber },
          quantity: payload.quantity,
          avgWeightG: payload.avgWeightG,
          allocationType: payload.allocationType,
          allocationDate: payload.allocatedAt || new Date(),
          notes: payload.notes,
          actorUserId: allocatedBy,
          caller: { roles: userRoles, assignedSiteIds: callerAssignedSiteIds },
          // Admins may consciously exceed the cap; the service records the
          // CAPACITY_BLOCKED audit row when they do.
          capacityMode: 'admin-override',
          auditSource: 'AllocateToTankHandler',
        });
        const tankBatch = stocked.tankBatch;
        const biomassKg = stocked.allocation.biomassKg;

        // Batch status güncelle (ilk stoklama ise)
        if (
          batch.status === BatchStatus.QUARANTINE &&
          payload.allocationType === AllocationType.INITIAL_STOCKING
        ) {
          batch.status = BatchStatus.ACTIVE;
          batch.statusChangedAt = new Date();
          await queryRunner.manager.save(batch);
        }

        await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, [
          payload.tankId,
        ]);

        // Enqueue BatchAllocatedToTankEvent into the transactional outbox BEFORE commit.
        const allocationDate = payload.allocatedAt || new Date();
        const eventBiomassKg = (payload.quantity * (payload.avgWeightG ?? 0)) / 1000;
        const allocationEvent: BatchAllocatedToTankEvent = {
          ...createBaseEvent<BatchAllocatedToTankEvent>('BatchAllocatedToTank', tenantId, {
            aggregateId: batchId,
            aggregateType: 'Batch',
          }),
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
          responseType: 'Batch',
          responseId: batch.id,
          responsePayload: { id: batch.id },
        });

        this.logger.log(
          `Batch ${batchId} allocated to tank ${payload.tankId} — ` +
            `qty=${payload.quantity}, type=${payload.allocationType}, tenant=${tenantId}`,
        );

        // Return the (updated) Batch — the @Mutation declares `() => Batch` and the
        // web/mobile clients read `Batch{currentQuantity,…}` to refresh after
        // stocking. Returning the TankAllocation here previously gave the client a
        // malformed object, so the tank/batch counts didn't refresh post-allocation.
        return batch;
      },
      { isolation: 'SERIALIZABLE' },
    );
  }
}
