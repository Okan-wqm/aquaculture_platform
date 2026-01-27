/**
 * Delete Equipment Command Handler
 * Supports cascade soft delete of all related items
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { DeleteEquipmentCommand } from '../commands/delete-equipment.command';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';

@CommandHandler(DeleteEquipmentCommand)
export class DeleteEquipmentHandler implements ICommandHandler<DeleteEquipmentCommand> {
  private readonly logger = new Logger(DeleteEquipmentHandler.name);

  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: DeleteEquipmentCommand): Promise<boolean> {
    const { equipmentId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting equipment ${equipmentId} for tenant ${tenantId} (cascade: ${cascade})`);

    // Find existing equipment
    const equipment = await this.equipmentRepository.findOne({
      where: { id: equipmentId, tenantId, isDeleted: false },
    });

    if (!equipment) {
      throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
    }

    // Get child equipment
    const childEquipment = await this.getChildEquipmentRecursive(equipmentId, tenantId);

    // Get sub-equipment
    const subEquipment = await this.subEquipmentRepository.find({
      where: { parentEquipmentId: equipmentId, tenantId },
    });

    if (!cascade) {
      // Old behavior: block if equipment has children
      if (childEquipment.length > 0) {
        throw new BadRequestException(
          `Cannot delete equipment "${equipment.name}". It has ${childEquipment.length} child equipment(s). Use cascade=true to delete all related items.`
        );
      }

      if (subEquipment.length > 0) {
        throw new BadRequestException(
          `Cannot delete equipment "${equipment.name}". It has ${subEquipment.length} sub-equipment(s). Use cascade=true to delete all related items.`
        );
      }
    } else {
      // Cascade delete all children
      this.logger.log(`Cascade deleting equipment ${equipmentId} with ${childEquipment.length} child equipment and ${subEquipment.length} sub-equipment`);
      const now = new Date();

      // Soft delete all child equipment (in reverse order - children first)
      for (const child of childEquipment.reverse()) {
        child.isDeleted = true;
        child.deletedAt = now;
        child.deletedBy = userId;
        child.isActive = false;
        child.updatedBy = userId;
        await this.equipmentRepository.save(child);
        this.logger.log(`Soft deleted child equipment ${child.id}`);
      }

      // Deactivate all sub-equipment (SubEquipment doesn't have soft delete fields)
      if (subEquipment.length > 0) {
        await this.subEquipmentRepository
          .createQueryBuilder()
          .update(SubEquipment)
          .set({
            isActive: false,
            updatedBy: userId,
          })
          .where('parentEquipmentId = :equipmentId', { equipmentId })
          .andWhere('tenantId = :tenantId', { tenantId })
          .execute();

        this.logger.log(`Deactivated ${subEquipment.length} sub-equipment for equipment ${equipmentId}`);
      }
    }

    // If equipment has a parent, decrement the parent's subEquipmentCount
    if (equipment.parentEquipmentId) {
      await this.equipmentRepository.decrement(
        { id: equipment.parentEquipmentId },
        'subEquipmentCount',
        1
      );
      this.logger.log(`Decremented subEquipmentCount for parent equipment ${equipment.parentEquipmentId}`);
    }

    // Soft delete - mark as deleted AND inactive
    equipment.isDeleted = true;
    equipment.deletedAt = new Date();
    equipment.deletedBy = userId;
    equipment.isActive = false;
    equipment.updatedBy = userId;
    await this.equipmentRepository.save(equipment);

    this.logger.log(`Equipment ${equipmentId} marked as deleted`);

    // Domain event: EquipmentDeleted
    // await this.eventBus?.publish(new EquipmentDeletedEvent({
    //   tenantId,
    //   equipmentId: equipment.id,
    //   name: equipment.name,
    //   cascade,
    //   deletedBy: userId,
    // }));

    return true;
  }

  /**
   * Recursively get all child equipment
   */
  private async getChildEquipmentRecursive(
    parentId: string,
    tenantId: string,
  ): Promise<Equipment[]> {
    const children = await this.equipmentRepository.find({
      where: { parentEquipmentId: parentId, tenantId, isDeleted: false },
    });

    let allChildren = [...children];

    for (const child of children) {
      const grandChildren = await this.getChildEquipmentRecursive(child.id, tenantId);
      allChildren = [...allChildren, ...grandChildren];
    }

    return allChildren;
  }
}
