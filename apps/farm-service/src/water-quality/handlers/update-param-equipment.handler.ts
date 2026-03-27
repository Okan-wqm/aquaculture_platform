/**
 * UpdateParamEquipmentHandler
 *
 * Updates an existing parameter-equipment mapping.
 * Finds by id + tenantId, applies partial updates.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { UpdateParamEquipmentCommand } from '../commands/update-param-equipment.command';
import { WaterQualityParamEquipment, MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';

@Injectable()
@CommandHandler(UpdateParamEquipmentCommand)
export class UpdateParamEquipmentHandler
  implements ICommandHandler<UpdateParamEquipmentCommand, WaterQualityParamEquipment>
{
  private readonly logger = new Logger(UpdateParamEquipmentHandler.name);

  constructor(
    @InjectRepository(WaterQualityParamEquipment)
    private readonly mappingRepository: Repository<WaterQualityParamEquipment>,
  ) {}

  async execute(command: UpdateParamEquipmentCommand): Promise<WaterQualityParamEquipment> {
    const { tenantId, mappingId, payload } = command;

    this.logger.log(`Updating param-equipment mapping ${mappingId} for tenant ${tenantId}`);

    const mapping = await this.mappingRepository.findOne({
      where: { id: mappingId, tenantId },
    });

    if (!mapping) {
      throw new NotFoundException(
        `Param-equipment mapping '${mappingId}' not found for this tenant`,
      );
    }

    // Apply only defined fields from payload
    if (payload.monitoringFrequency !== undefined) {
      mapping.monitoringFrequency = payload.monitoringFrequency as MonitoringFrequency;
    }
    if (payload.sensorId !== undefined) {
      mapping.sensorId = payload.sensorId;
    }
    if (payload.alertEnabled !== undefined) {
      mapping.alertEnabled = payload.alertEnabled;
    }
    if (payload.isActive !== undefined) {
      mapping.isActive = payload.isActive;
    }
    if (payload.notes !== undefined) {
      mapping.notes = payload.notes;
    }

    const saved = await this.mappingRepository.save(mapping);

    this.logger.log(`Param-equipment mapping ${mappingId} updated for tenant ${tenantId}`);

    return saved;
  }
}
