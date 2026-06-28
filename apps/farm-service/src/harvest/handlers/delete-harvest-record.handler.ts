/**
 * DeleteHarvestRecordHandler
 *
 * Handles the DeleteHarvestRecordCommand to soft delete a harvest record.
 * Also reverses the batch and tank quantity changes.
 *
 * @module Harvest/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso,
  createBaseEvent,
  type HarvestRecordCancelledEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank } from '../../tank/entities/tank.entity';
import { DeleteHarvestRecordCommand } from '../commands/delete-harvest-record.command';
import { HarvestRecord, HarvestRecordStatus } from '../entities/harvest-record.entity';

@Injectable()
@CommandHandler(DeleteHarvestRecordCommand)
export class DeleteHarvestRecordHandler implements ICommandHandler<DeleteHarvestRecordCommand, boolean> {
  constructor(
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly farmStockProjection: FarmStockProjectionService =
      defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: DeleteHarvestRecordCommand): Promise<boolean> {
    const { tenantId, harvestRecordId, deletedBy } = command;

    // Find the harvest record
    const harvestRecord = await this.harvestRepository.findOne({
      where: { id: harvestRecordId, tenantId },
    });

    if (!harvestRecord) {
      throw new NotFoundException(`Harvest record ${harvestRecordId} not found`);
    }

    // Prevent deletion of dispatched/delivered harvests
    if (harvestRecord.status === HarvestRecordStatus.DISPATCHED ||
        harvestRecord.status === HarvestRecordStatus.DELIVERED) {
      throw new BadRequestException('Cannot delete dispatched or delivered harvest records');
    }

    // All reversal operations in a single transaction for data consistency
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Reverse the batch quantity changes
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: harvestRecord.batchId, tenantId },
      });

      if (batch) {
        batch.currentQuantity += harvestRecord.quantityHarvested;
        batch.harvestedQuantity = Math.max(0, (batch.harvestedQuantity || 0) - harvestRecord.quantityHarvested);
        batch.retentionRate = batch.getRetentionRate();
        batch.updatedBy = deletedBy;
        await queryRunner.manager.save(Batch, batch);
      }

      // Reverse the tank batch changes
      if (harvestRecord.tankId) {
        const tankBatch = await queryRunner.manager.findOne(TankBatch, {
          where: { tenantId, tankId: harvestRecord.tankId },
        });

        if (tankBatch) {
          const biomassKg = Number(harvestRecord.totalBiomass);
          tankBatch.totalQuantity = Number(tankBatch.totalQuantity) + harvestRecord.quantityHarvested;
          tankBatch.totalBiomassKg = Number(tankBatch.totalBiomassKg) + biomassKg;
          tankBatch.currentQuantity = tankBatch.totalQuantity;
          tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;

          if (tankBatch.totalQuantity > 0) {
            tankBatch.avgWeightG = (Number(tankBatch.totalBiomassKg) * 1000) / tankBatch.totalQuantity;
          }

          await queryRunner.manager.save(TankBatch, tankBatch);
        }

        // Reverse tank changes
        const tank = await queryRunner.manager.findOne(Tank, {
          where: { id: harvestRecord.tankId, tenantId },
        });

        if (tank) {
          tank.currentBiomass = Number(tank.currentBiomass || 0) + Number(harvestRecord.totalBiomass);
          tank.currentCount = (tank.currentCount || 0) + harvestRecord.quantityHarvested;
          await queryRunner.manager.save(Tank, tank);
        }

        await this.farmStockProjection.refreshContainers(
          queryRunner.manager,
          tenantId,
          [harvestRecord.tankId],
        );
      }

      // Mark the harvest record as cancelled (soft delete)
      harvestRecord.status = HarvestRecordStatus.CANCELLED;
      await queryRunner.manager.save(HarvestRecord, harvestRecord);

      // HarvestRecordCancelled — announce the cascade reversal so
      // Slakterapport consumers withdraw their projection line and
      // batch-retention projections reverse the retention-rate bump
      // without re-reading aggregates.
      const event: HarvestRecordCancelledEvent = {
        ...createBaseEvent<HarvestRecordCancelledEvent>('HarvestRecordCancelled', tenantId, {
          aggregateId: harvestRecord.id,
          aggregateType: 'HarvestRecord',
        }),
        harvestRecordId: harvestRecord.id,
        batchId: harvestRecord.batchId,
        tankId: harvestRecord.tankId,
        reversedQuantity: harvestRecord.quantityHarvested,
        reversedBiomassKg: Number(harvestRecord.totalBiomass),
        cancelledAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);
    });

    return true;
  }
}
