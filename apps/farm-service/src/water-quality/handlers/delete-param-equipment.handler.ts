/**
 * DeleteParamEquipmentHandler
 *
 * Hard-deletes a parameter-equipment junction record.
 * Junction records are not soft-deleted -- they are removed entirely.
 *
 * @module WaterQuality/Handlers
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DeleteParamEquipmentCommand } from '../commands/delete-param-equipment.command';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';

@Injectable()
@CommandHandler(DeleteParamEquipmentCommand)
export class DeleteParamEquipmentHandler
  implements ICommandHandler<DeleteParamEquipmentCommand, boolean>
{
  private readonly logger = new Logger(DeleteParamEquipmentHandler.name);

  constructor(
    @InjectRepository(WaterQualityParamEquipment)
    private readonly mappingRepository: Repository<WaterQualityParamEquipment>,
  ) {}

  async execute(command: DeleteParamEquipmentCommand): Promise<boolean> {
    const { tenantId, mappingId } = command;

    this.logger.log(`Deleting param-equipment mapping ${mappingId} for tenant ${tenantId}`);

    const mapping = await this.mappingRepository.findOne({
      where: { id: mappingId, tenantId },
    });

    if (!mapping) {
      throw new NotFoundException(
        `Param-equipment mapping '${mappingId}' not found for this tenant`,
      );
    }

    await this.mappingRepository.remove(mapping);

    this.logger.log(`Param-equipment mapping ${mappingId} hard-deleted for tenant ${tenantId}`);

    return true;
  }
}
