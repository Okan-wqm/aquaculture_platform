/**
 * Update SubEquipment Command Handler
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, InternalServerErrorException, NotFoundException, Logger } from '@nestjs/common';
import { UpdateSubEquipmentCommand } from '../commands/update-sub-equipment.command';
import { SubEquipment } from '../entities/sub-equipment.entity';

@CommandHandler(UpdateSubEquipmentCommand)
export class UpdateSubEquipmentHandler implements ICommandHandler<UpdateSubEquipmentCommand, SubEquipment> {
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

    // Update fields - exclude id to prevent entity identity corruption
    const { id: _id, ...updateFields } = input;
    Object.assign(subEquipment, {
      ...updateFields,
      updatedBy: userId,
    });

    const updatedSubEquipment = await this.subEquipmentRepository.save(subEquipment);

    this.logger.log(`Sub-equipment ${id} updated successfully`);

    // Return with relations — ALWAYS scope post-write re-reads by
    // tenantId. UUIDs are globally unique so filtering by id alone
    // would work for the happy path, but the discipline keeps this
    // line correct even if an upstream refactor weakens the
    // initial tenant check; a crafted ID from another tenant would
    // otherwise be served back through this handler.
    const reloaded = await this.subEquipmentRepository.findOne({
      where: { id: updatedSubEquipment.id, tenantId },
      relations: ['subEquipmentType', 'parentEquipment'],
    });
    if (!reloaded) {
      // Should not happen — we just saved the row — but a disappearing
      // row mid-request is a real (albeit rare) concurrency case,
      // and silently returning an `as Promise<SubEquipment>` lie
      // would crash consumers downstream with a less-useful trace.
      throw new InternalServerErrorException(
        `Sub-equipment ${updatedSubEquipment.id} vanished between save and reload`,
      );
    }
    return reloaded;
  }
}
