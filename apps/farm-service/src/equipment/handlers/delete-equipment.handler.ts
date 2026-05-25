/**
 * Delete Equipment Command Handler
 * Supports cascade soft delete of all related items
 *
 * Handles deletion for both Equipment and Tank entities.
 * When an equipment ID is found in the tanks table, the delete is delegated
 * to delete the Tank entity instead.
 */
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { EquipmentDeletedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, In } from 'typeorm';

import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank } from '../../tank/entities/tank.entity';
import { DeleteEquipmentCommand } from '../commands/delete-equipment.command';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';

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
    private readonly farmStockProjection: FarmStockProjectionService,
    private readonly outboxPublisher: OutboxPublisher,
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
    }

    await this.equipmentRepository.manager.transaction(async (manager) => {
      const deletedAt = new Date();

      if (cascade) {
        // Cascade delete all children
        this.logger.log(`Cascade deleting equipment ${equipmentId} with ${childEquipment.length} child equipment and ${subEquipment.length} sub-equipment`);

        // Soft delete all child equipment (in reverse order - children first)
        for (const child of [...childEquipment].reverse()) {
          child.isDeleted = true;
          child.deletedAt = deletedAt;
          child.deletedBy = userId;
          child.isActive = false;
          child.updatedBy = userId;
          await manager.save(Equipment, child);
          this.logger.log(`Soft deleted child equipment ${child.id}`);
        }

        // Deactivate all sub-equipment (SubEquipment doesn't have soft delete fields)
        if (subEquipment.length > 0) {
          await manager
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
        await manager.decrement(
          Equipment,
          { id: equipment.parentEquipmentId },
          'subEquipmentCount',
          1
        );
        this.logger.log(`Decremented subEquipmentCount for parent equipment ${equipment.parentEquipmentId}`);
      }

      // Soft delete - mark as deleted AND inactive
      equipment.isDeleted = true;
      equipment.deletedAt = deletedAt;
      equipment.deletedBy = userId;
      equipment.isActive = false;
      equipment.updatedBy = userId;
      await manager.save(Equipment, equipment);
      if (equipment.isTank) {
        await this.farmStockProjection.refreshContainers(
          manager,
          tenantId,
          [equipment.id],
        );
      }

      const event: EquipmentDeletedEvent = {
        ...createBaseEvent<EquipmentDeletedEvent>('EquipmentDeleted', tenantId),
        equipmentId: equipment.id,
        name: equipment.name,
        code: equipment.code,
        deletedAt,
      };
      await this.outboxPublisher.enqueue(event, manager, {
        aggregateId: equipment.id,
      });
    });

    this.logger.log(`Equipment ${equipmentId} marked as deleted`);

    return true;
  }

  /**
   * Get all child equipment using batch loading to avoid N+1 queries
   * Uses iterative breadth-first approach with depth limit
   */
  private async getChildEquipmentRecursive(
    parentId: string,
    tenantId: string,
    maxDepth = 10,
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
      await this.tankRepository.manager.transaction(async (manager) => {
        await manager.delete(TankBatch, { tankId: tank.id, tenantId });

        this.logger.log(`Removed ${activeBatches.length} empty tank batch records for tank ${tank.id}`);

        // Soft delete - set isActive to false
        tank.isActive = false;
        tank.updatedBy = userId;

        await manager.save(Tank, tank);
        await this.farmStockProjection.refreshContainers(
          manager,
          tenantId,
          [tank.id],
        );
      });
    } else {
      await this.tankRepository.manager.transaction(async (manager) => {
        // Soft delete - set isActive to false
        tank.isActive = false;
        tank.updatedBy = userId;

        await manager.save(Tank, tank);
        await this.farmStockProjection.refreshContainers(
          manager,
          tenantId,
          [tank.id],
        );
      });
    }

    this.logger.log(`Tank ${tank.id} (${tank.name}) soft-deleted via equipment resolver`);

    return true;
  }
}
