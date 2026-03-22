/**
 * Delete Equipment Command Handler
 * Supports cascade soft delete of all related items
 *
 * Handles deletion for both Equipment and Tank entities.
 * When an equipment ID is found in the tanks table, the delete is delegated
 * to delete the Tank entity instead.
 */
import { randomUUID } from 'crypto';

import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { EquipmentDeletedEvent } from '@platform/event-contracts';
import { DeleteEquipmentCommand } from '../commands/delete-equipment.command';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

@CommandHandler(DeleteEquipmentCommand)
export class DeleteEquipmentHandler implements ICommandHandler<DeleteEquipmentCommand, boolean> {
  private readonly logger = new Logger(DeleteEquipmentHandler.name);

  constructor(
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(SubEquipment)
    private readonly subEquipmentRepository: Repository<SubEquipment>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: DeleteEquipmentCommand): Promise<boolean> {
    const { equipmentId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting equipment ${equipmentId} for tenant ${tenantId} (cascade: ${cascade})`);

    // Check if this ID exists in the tanks table first
    const tank = await this.tankRepository.findOne({
      where: { id: equipmentId, tenantId },
    });

    if (tank) {
      // This is a tank - delegate to tank delete logic
      this.logger.log(`Equipment ${equipmentId} is a tank, deleting Tank entity`);
      return this.deleteTank(tank, tenantId, userId);
    }

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

    // Publish domain event: EquipmentDeleted
    if (this.eventBus) {
      try {
        const event: EquipmentDeletedEvent = {
          eventId: randomUUID(),
          eventType: 'EquipmentDeleted',
          tenantId,
          timestamp: new Date(),
          equipmentId: equipment.id,
          name: equipment.name,
          code: equipment.code,
          deletedAt: new Date(),
          version: 1,
        };
        await this.eventBus.publish(event);
        this.logger.debug(`Published EquipmentDeletedEvent for equipment ${equipment.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish EquipmentDeletedEvent: ${(eventError as Error).message}`);
      }
    }

    return true;
  }

  /**
   * Get all child equipment using batch loading to avoid N+1 queries
   * Uses iterative breadth-first approach with depth limit
   */
  private async getChildEquipmentRecursive(
    parentId: string,
    tenantId: string,
    maxDepth: number = 10,
  ): Promise<Equipment[]> {
    const allChildren: Equipment[] = [];
    let currentParentIds = [parentId];
    let depth = 0;

    while (currentParentIds.length > 0 && depth < maxDepth) {
      // Batch fetch all children for current level
      const children = await this.equipmentRepository.find({
        where: {
          parentEquipmentId: In(currentParentIds),
          tenantId,
          isDeleted: false,
        },
      });

      if (children.length === 0) {
        break;
      }

      allChildren.push(...children);
      currentParentIds = children.map((child) => child.id);
      depth++;
    }

    if (depth >= maxDepth) {
      this.logger.warn(
        `Max depth (${maxDepth}) reached while fetching child equipment for parent ${parentId}`,
      );
    }

    return allChildren;
  }

  /**
   * Delete Tank entity when accessed via equipment resolver
   * Handles cascade requirements for tank batches and related data
   */
  private async deleteTank(
    tank: Tank,
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    // Cannot delete tank with active biomass
    if (tank.currentBiomass > 0) {
      throw new BadRequestException(
        `Cannot delete tank "${tank.name}": it has ${tank.currentBiomass}kg of active biomass. ` +
          'Please transfer or harvest first.',
      );
    }

    // Check for active tank batches
    const activeBatches = await this.tankBatchRepository.find({
      where: { tankId: tank.id, tenantId },
    });

    if (activeBatches.length > 0) {
      // Check if any batch has fish
      const batchesWithFish = activeBatches.filter(
        b => (b.totalQuantity && b.totalQuantity > 0) || (b.cleanerFishQuantity && b.cleanerFishQuantity > 0)
      );

      if (batchesWithFish.length > 0) {
        throw new BadRequestException(
          `Cannot delete tank "${tank.name}": it has ${batchesWithFish.length} active batch(es) with fish. ` +
            'Please transfer or harvest first.',
        );
      }

      // Remove empty tank batches (they will be recreated if needed)
      await this.tankBatchRepository
        .createQueryBuilder()
        .delete()
        .from(TankBatch)
        .where('tankId = :tankId', { tankId: tank.id })
        .andWhere('tenantId = :tenantId', { tenantId })
        .execute();

      this.logger.log(`Removed ${activeBatches.length} empty tank batch records for tank ${tank.id}`);
    }

    // Soft delete - set isActive to false
    tank.isActive = false;
    tank.updatedBy = userId;

    await this.tankRepository.save(tank);

    this.logger.log(`Tank ${tank.id} (${tank.name}) soft-deleted via equipment resolver`);

    return true;
  }
}
