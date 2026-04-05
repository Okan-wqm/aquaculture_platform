/**
 * UpdateHarvestRecordHandler
 *
 * Handles the UpdateHarvestRecordCommand to update an existing harvest record.
 *
 * Enterprise fixes (S2 HIGH-003):
 * - QueryRunner transaction prevents partial commit on save failure
 * - Pessimistic write lock prevents concurrent last-write-wins corruption
 * - updatedBy written to entity for regulatory audit trail
 *
 * @module Harvest/Handlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateHarvestRecordCommand } from '../commands/update-harvest-record.command';
import { HarvestRecord } from '../entities/harvest-record.entity';

@Injectable()
@CommandHandler(UpdateHarvestRecordCommand)
export class UpdateHarvestRecordHandler implements ICommandHandler<UpdateHarvestRecordCommand, HarvestRecord> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
  ) {}

  async execute(command: UpdateHarvestRecordCommand): Promise<HarvestRecord> {
    const { tenantId, harvestRecordId, data, updatedBy } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Pessimistic write lock: concurrent updates produce last-write-wins without
      // conflict detection — lock serialises concurrent callers at the DB level.
      const harvestRecord = await queryRunner.manager.findOne(HarvestRecord, {
        where: { id: harvestRecordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!harvestRecord) {
        throw new NotFoundException(`Harvest record ${harvestRecordId} not found`);
      }

      // Audit trail: record who made this update (regulatory requirement)
      if (updatedBy) {
        harvestRecord.updatedBy = updatedBy;
      }

      // Update fields if provided
      if (data.status !== undefined) harvestRecord.status = data.status;
      if (data.quantityHarvested !== undefined) harvestRecord.quantityHarvested = data.quantityHarvested;
      if (data.totalBiomass !== undefined) harvestRecord.totalBiomass = data.totalBiomass;
      if (data.averageWeight !== undefined) harvestRecord.averageWeight = data.averageWeight;
      if (data.qualityGrade !== undefined) harvestRecord.qualityGrade = data.qualityGrade;
      if (data.method !== undefined) harvestRecord.method = data.method;
      if (data.productForm !== undefined) harvestRecord.productForm = data.productForm;
      if (data.totalRevenue !== undefined) harvestRecord.totalRevenue = data.totalRevenue;
      if (data.harvestCost !== undefined) harvestRecord.harvestCost = data.harvestCost;
      if (data.currency !== undefined) harvestRecord.currency = data.currency;
      if (data.mortalityDuringHarvest !== undefined) harvestRecord.mortalityDuringHarvest = data.mortalityDuringHarvest;
      if (data.rejectedQuantity !== undefined) harvestRecord.rejectedQuantity = data.rejectedQuantity;
      if (data.rejectionReason !== undefined) harvestRecord.rejectionReason = data.rejectionReason;
      if (data.notes !== undefined) harvestRecord.notes = data.notes;

      const saved = await queryRunner.manager.save(HarvestRecord, harvestRecord);
      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
