/**
 * UpdateHarvestRecordHandler
 *
 * Handles the UpdateHarvestRecordCommand to update an existing harvest record.
 *
 * @module Harvest/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateHarvestRecordCommand } from '../commands/update-harvest-record.command';
import { HarvestRecord } from '../entities/harvest-record.entity';

@Injectable()
@CommandHandler(UpdateHarvestRecordCommand)
export class UpdateHarvestRecordHandler implements ICommandHandler<UpdateHarvestRecordCommand, HarvestRecord> {
  constructor(
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
  ) {}

  async execute(command: UpdateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, harvestRecordId, data, updatedBy } = command;

    // Find the harvest record
    const harvestRecord = await this.harvestRepository.findOne({
      where: { id: harvestRecordId, tenantId },
    });

    if (!harvestRecord) {
      throw new NotFoundException(`Harvest record ${harvestRecordId} not found`);
    }

    // Update fields if provided
    if (data.status !== undefined) {
      harvestRecord.status = data.status;
    }
    if (data.quantityHarvested !== undefined) {
      harvestRecord.quantityHarvested = data.quantityHarvested;
    }
    if (data.totalBiomass !== undefined) {
      harvestRecord.totalBiomass = data.totalBiomass;
    }
    if (data.averageWeight !== undefined) {
      harvestRecord.averageWeight = data.averageWeight;
    }
    if (data.qualityGrade !== undefined) {
      harvestRecord.qualityGrade = data.qualityGrade;
    }
    if (data.method !== undefined) {
      harvestRecord.method = data.method;
    }
    if (data.productForm !== undefined) {
      harvestRecord.productForm = data.productForm;
    }
    if (data.totalRevenue !== undefined) {
      harvestRecord.totalRevenue = data.totalRevenue;
    }
    if (data.harvestCost !== undefined) {
      harvestRecord.harvestCost = data.harvestCost;
    }
    if (data.currency !== undefined) {
      harvestRecord.currency = data.currency;
    }
    if (data.mortalityDuringHarvest !== undefined) {
      harvestRecord.mortalityDuringHarvest = data.mortalityDuringHarvest;
    }
    if (data.rejectedQuantity !== undefined) {
      harvestRecord.rejectedQuantity = data.rejectedQuantity;
    }
    if (data.rejectionReason !== undefined) {
      harvestRecord.rejectionReason = data.rejectionReason;
    }
    if (data.notes !== undefined) {
      harvestRecord.notes = data.notes;
    }

    // Save and return the updated record
    return this.harvestRepository.save(harvestRecord);
  }
}
