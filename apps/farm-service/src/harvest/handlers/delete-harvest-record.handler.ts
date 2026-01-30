/**
 * DeleteHarvestRecordHandler
 *
 * Handles the DeleteHarvestRecordCommand to soft delete a harvest record.
 * Also reverses the batch and tank quantity changes.
 *
 * @module Harvest/Handlers
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DeleteHarvestRecordCommand } from '../commands/delete-harvest-record.command';
import { HarvestRecord, HarvestRecordStatus } from '../entities/harvest-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';

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

    // Reverse the batch quantity changes
    const batch = await this.batchRepository.findOne({
      where: { id: harvestRecord.batchId, tenantId },
    });

    if (batch) {
      batch.currentQuantity += harvestRecord.quantityHarvested;
      batch.harvestedQuantity = Math.max(0, (batch.harvestedQuantity || 0) - harvestRecord.quantityHarvested);
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = deletedBy;
      await this.batchRepository.save(batch);
    }

    // Reverse the tank batch changes
    if (harvestRecord.tankId) {
      const tankBatch = await this.tankBatchRepository.findOne({
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

        await this.tankBatchRepository.save(tankBatch);
      }

      // Reverse tank changes
      const tank = await this.tankRepository.findOne({
        where: { id: harvestRecord.tankId, tenantId },
      });

      if (tank) {
        tank.currentBiomass = Number(tank.currentBiomass || 0) + Number(harvestRecord.totalBiomass);
        tank.currentCount = (tank.currentCount || 0) + harvestRecord.quantityHarvested;
        await this.tankRepository.save(tank);
      }
    }

    // Mark the harvest record as cancelled (soft delete)
    harvestRecord.status = HarvestRecordStatus.CANCELLED;
    await this.harvestRepository.save(harvestRecord);

    return true;
  }
}
