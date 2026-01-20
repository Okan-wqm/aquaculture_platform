/**
 * UpdateBatchHandler
 *
 * UpdateBatchCommand'ı işler ve batch bilgilerini günceller.
 *
 * @module Batch/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateBatchCommand } from '../commands/update-batch.command';
import { Batch } from '../entities/batch.entity';

@Injectable()
@CommandHandler(UpdateBatchCommand)
export class UpdateBatchHandler implements ICommandHandler<UpdateBatchCommand, Batch> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  async execute(command: UpdateBatchCommand): Promise<Batch> {
    const { tenantId, batchId, payload, updatedBy } = command;

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId, isActive: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Güncellenebilir alanları güncelle
    if (payload.name !== undefined) {
      batch.name = payload.name;
    }

    if (payload.description !== undefined) {
      batch.description = payload.description;
    }

    if (payload.strain !== undefined) {
      batch.strain = payload.strain;
    }

    if (payload.targetFCR !== undefined) {
      batch.fcr.target = payload.targetFCR;
      batch.fcr.isUserOverride = true;
      batch.fcr.lastUpdatedAt = new Date();
    }

    if (payload.expectedHarvestDate !== undefined) {
      batch.expectedHarvestDate = payload.expectedHarvestDate;
      batch.growthMetrics.projections.harvestDate = payload.expectedHarvestDate;
    }

    if (payload.notes !== undefined) {
      batch.notes = payload.notes;
    }

    batch.updatedBy = updatedBy;

    return this.batchRepository.save(batch);
  }
}
