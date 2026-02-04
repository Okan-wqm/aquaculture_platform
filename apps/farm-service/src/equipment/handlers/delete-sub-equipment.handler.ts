/**
 * Delete SubEquipment Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteSubEquipmentCommand } from '../commands/delete-sub-equipment.command';
import { SubEquipment } from '../entities/sub-equipment.entity';
import { Equipment } from '../entities/equipment.entity';

@CommandHandler(DeleteSubEquipmentCommand)
export class DeleteSubEquipmentHandler implements ICommandHandler<DeleteSubEquipmentCommand> {
  private readonly logger = new Logger(DeleteSubEquipmentHandler.name);

  constructor(
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
  ) {}

  async execute(command: DeleteSubEquipmentCommand): Promise<boolean> {
    const { id, tenantId, userId } = command;

    this.logger.log(`Deleting sub-equipment ${id} for tenant ${tenantId} by user ${userId}`);

    // Find the sub-equipment
    const subEquipment = await this.subEquipmentRepository.findOne({
      where: { id, tenantId },
    });

    if (!subEquipment) {
      throw new NotFoundException(`Sub-equipment with ID "${id}" not found`);
    }

    const parentEquipmentId = subEquipment.parentEquipmentId;

    // Soft delete by setting isActive to false
    await this.subEquipmentRepository.update(id, {
      isActive: false,
      updatedBy: userId,
    });

    // Decrement parent equipment's subEquipmentCount
    await this.equipmentRepository.decrement(
      { id: parentEquipmentId },
      'subEquipmentCount',
      1
    );

    this.logger.log(`Sub-equipment ${id} deleted successfully`);

    return true;
  }
}
