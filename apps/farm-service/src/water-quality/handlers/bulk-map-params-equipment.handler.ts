/**
 * BulkMapParamsEquipmentHandler
 *
 * Maps multiple parameter configs to a single equipment item.
 * Skips any mappings that already exist (ON CONFLICT DO NOTHING pattern).
 * Returns all mappings for the target equipment after the operation.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { BulkMapParamsEquipmentCommand } from '../commands/bulk-map-params-equipment.command';
import { WaterQualityParamEquipment, MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';

@Injectable()
@CommandHandler(BulkMapParamsEquipmentCommand)
export class BulkMapParamsEquipmentHandler
  implements ICommandHandler<BulkMapParamsEquipmentCommand, WaterQualityParamEquipment[]>
{
  private readonly logger = new Logger(BulkMapParamsEquipmentHandler.name);

  constructor(
    @InjectRepository(WaterQualityParamEquipment)
    private readonly mappingRepository: Repository<WaterQualityParamEquipment>,
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(command: BulkMapParamsEquipmentCommand): Promise<WaterQualityParamEquipment[]> {
    const { tenantId, payload } = command;
    const { equipmentId, parameterConfigIds, monitoringFrequency } = payload;

    this.logger.log(
      `Bulk mapping ${parameterConfigIds.length} params to equipment ${equipmentId} for tenant ${tenantId}`,
    );

    // Validate equipment exists for tenant
    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId },
    });

    if (!equipment) {
      throw new NotFoundException(
        `Equipment '${equipmentId}' not found for this tenant`,
      );
    }

    // Fetch existing mappings for this equipment to skip duplicates
    const existingMappings = await this.mappingRepository.find({
      where: { tenantId, equipmentId },
      select: ['parameterConfigId'],
    });
    const existingParamIds = new Set(existingMappings.map((m) => m.parameterConfigId));

    const frequency =
      (monitoringFrequency as MonitoringFrequency) ?? MonitoringFrequency.ON_DEMAND;

    let createdCount = 0;
    let skippedCount = 0;

    for (const paramConfigId of parameterConfigIds) {
      if (existingParamIds.has(paramConfigId)) {
        skippedCount++;
        continue;
      }

      // Validate parameterConfigId exists for tenant
      const paramConfig = await this.configRepository.findOne({
        where: { id: paramConfigId, tenantId },
      });

      if (!paramConfig) {
        this.logger.warn(
          `Skipping unknown parameter config '${paramConfigId}' for tenant ${tenantId}`,
        );
        skippedCount++;
        continue;
      }

      const mapping = this.mappingRepository.create({
        tenantId,
        parameterConfigId: paramConfigId,
        equipmentId,
        monitoringFrequency: frequency,
      });

      await this.mappingRepository.save(mapping);
      createdCount++;
    }

    this.logger.log(
      `Bulk mapping complete: created ${createdCount}, skipped ${skippedCount} for equipment ${equipmentId}`,
    );

    // Return all mappings for this equipment
    return this.mappingRepository.find({
      where: { tenantId, equipmentId },
      relations: ['parameterConfig'],
      order: { createdAt: 'ASC' },
    });
  }
}
