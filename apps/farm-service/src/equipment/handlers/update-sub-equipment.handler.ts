/**
 * Update SubEquipment Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { UpdateSubEquipmentCommand } from '../commands/update-sub-equipment.command';
import { SubEquipment } from '../entities/sub-equipment.entity';

@CommandHandler(UpdateSubEquipmentCommand)
export class UpdateSubEquipmentHandler implements ICommandHandler<UpdateSubEquipmentCommand> {
  private readonly logger = new Logger(UpdateSubEquipmentHandler.name);

  constructor(
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
  ) {}

  async execute(command: UpdateSubEquipmentCommand): Promise<SubEquipment> {
    const { id, input, tenantId, userId } = command;

    this.logger.log(`Updating sub-equipment ${id} for tenant ${tenantId}`);

    // Find existing sub-equipment
    const subEquipment = await this.subEquipmentRepository.findOne({
      where: { id, tenantId },
      relations: ['subEquipmentType', 'parentEquipment'],
    });

    if (!subEquipment) {
      throw new NotFoundException(`Sub-equipment with ID "${id}" not found`);
    }

    // Check for duplicate code if code is being changed
    if (input.code && input.code !== subEquipment.code) {
      const normalizedCode = input.code.toUpperCase();
      const existingByCode = await this.subEquipmentRepository.findOne({
        where: {
          tenantId,
          parentEquipmentId: subEquipment.parentEquipmentId,
          code: normalizedCode,
        },
      });
      if (existingByCode && existingByCode.id !== id) {
        throw new ConflictException(
          `Sub-equipment with code "${normalizedCode}" already exists for this parent equipment`
        );
      }
      input.code = normalizedCode;
    }

    // Check for duplicate serial number if serial number is being changed
    if (input.serialNumber && input.serialNumber !== subEquipment.serialNumber) {
      const existingBySerial = await this.subEquipmentRepository.findOne({
        where: { tenantId, serialNumber: input.serialNumber },
      });
      if (existingBySerial && existingBySerial.id !== id) {
        throw new ConflictException(`Sub-equipment with serial number "${input.serialNumber}" already exists`);
      }
    }

    // Update fields
    Object.assign(subEquipment, {
      ...input,
      updatedBy: userId,
    });

    // Remove id from the update since it's the identifier
    delete (subEquipment as unknown as Record<string, unknown>).id;
    subEquipment.id = id;

    const updatedSubEquipment = await this.subEquipmentRepository.save(subEquipment);

    this.logger.log(`Sub-equipment ${id} updated successfully`);

    // Return with relations
    return this.subEquipmentRepository.findOne({
      where: { id: updatedSubEquipment.id },
      relations: ['subEquipmentType', 'parentEquipment'],
    }) as Promise<SubEquipment>;
  }
}
