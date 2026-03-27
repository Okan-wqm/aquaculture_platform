/**
 * CreateParamEquipmentHandler
 *
 * Creates a new parameter-equipment mapping for a tenant.
 * Validates parameterConfigId and equipmentId exist for the tenant,
 * then checks the unique constraint before persisting.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { CreateParamEquipmentCommand } from '../commands/create-param-equipment.command';
import { WaterQualityParamEquipment, MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';

@Injectable()
@CommandHandler(CreateParamEquipmentCommand)
export class CreateParamEquipmentHandler
  implements ICommandHandler<CreateParamEquipmentCommand, WaterQualityParamEquipment>
{
  private readonly logger = new Logger(CreateParamEquipmentHandler.name);

  constructor(
    @InjectRepository(WaterQualityParamEquipment)
    private readonly mappingRepository: Repository<WaterQualityParamEquipment>,
    @InjectRepository(WaterQualityParameterConfig)
    private readonly configRepository: Repository<WaterQualityParameterConfig>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(command: CreateParamEquipmentCommand): Promise<WaterQualityParamEquipment> {
    const { tenantId, payload } = command;

    this.logger.log(
      `Creating param-equipment mapping: param=${payload.parameterConfigId}, equip=${payload.equipmentId} for tenant ${tenantId}`,
    );

    // Validate parameterConfigId exists for tenant
    const paramConfig = await this.configRepository.findOne({
      where: { id: payload.parameterConfigId, tenantId },
    });

    if (!paramConfig) {
      throw new NotFoundException(
        `Parameter config '${payload.parameterConfigId}' not found for this tenant`,
      );
    }

    // Validate equipmentId exists for tenant
    const equipment = await this.equipmentRepository.findOne({
      where: { id: payload.equipmentId, tenantId },
    });

    if (!equipment) {
      throw new NotFoundException(
        `Equipment '${payload.equipmentId}' not found for this tenant`,
      );
    }

    // Check unique constraint (tenantId + parameterConfigId + equipmentId)
    const existing = await this.mappingRepository.findOne({
      where: {
        tenantId,
        parameterConfigId: payload.parameterConfigId,
        equipmentId: payload.equipmentId,
      },
    });

    if (existing) {
      throw new ConflictException(
        `Mapping already exists for parameter '${payload.parameterConfigId}' and equipment '${payload.equipmentId}'`,
      );
    }

    const mapping = this.mappingRepository.create({
      tenantId,
      parameterConfigId: payload.parameterConfigId,
      equipmentId: payload.equipmentId,
      monitoringFrequency:
        (payload.monitoringFrequency as MonitoringFrequency) ?? MonitoringFrequency.ON_DEMAND,
      sensorId: payload.sensorId,
      alertEnabled: payload.alertEnabled ?? true,
      notes: payload.notes,
    });

    const saved = await this.mappingRepository.save(mapping);

    this.logger.log(
      `Param-equipment mapping created with ID ${saved.id} for tenant ${tenantId}`,
    );

    return saved;
  }
}
