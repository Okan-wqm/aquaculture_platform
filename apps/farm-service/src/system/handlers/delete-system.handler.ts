/**
 * Delete System Command Handler
 * Supports cascade soft delete of all related items
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { DeleteSystemCommand } from '../commands/delete-system.command';
import { System } from '../entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';

@CommandHandler(DeleteSystemCommand)
export class DeleteSystemHandler implements ICommandHandler<DeleteSystemCommand> {
  private readonly logger = new Logger(DeleteSystemHandler.name);

  constructor(
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Equipment)
    private readonly equipmentRepository: Repository<Equipment>,
    @InjectRepository(EquipmentSystem)
    private readonly equipmentSystemRepository: Repository<EquipmentSystem>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: DeleteSystemCommand): Promise<boolean> {
    const { systemId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting system ${systemId} for tenant ${tenantId} (cascade: ${cascade})`);

    // Find existing system
    const system = await this.systemRepository.findOne({
      where: { id: systemId, tenantId, isDeleted: false },
    });

    if (!system) {
      throw new NotFoundException(`System with ID "${systemId}" not found`);
    }

    // Get child systems
    const childSystems = await this.getChildSystemsRecursive(systemId, tenantId);

    if (!cascade) {
      // Old behavior: block if system has child systems
      if (childSystems.length > 0) {
        throw new BadRequestException(
          `Cannot delete system "${system.name}". It has ${childSystems.length} child system(s). Use cascade=true to delete all related items.`
        );
      }
    } else {
      // Cascade delete all child systems
      this.logger.log(`Cascade deleting system ${systemId} with ${childSystems.length} child systems`);
      const now = new Date();

      // Get all system IDs (including this one and all children)
      const allSystemIds = [systemId, ...childSystems.map((s) => s.id)];

      // Delete all equipment-system junction records for all systems
      await this.equipmentSystemRepository
        .createQueryBuilder()
        .delete()
        .where('systemId IN (:...systemIds)', { systemIds: allSystemIds })
        .andWhere('tenantId = :tenantId', { tenantId })
        .execute();

      this.logger.log(`Deleted equipment-system junction records for ${allSystemIds.length} systems`);

      // Soft delete all child systems (in reverse order - children first)
      for (const childSystem of childSystems.reverse()) {
        childSystem.softDelete(userId);
        await this.systemRepository.save(childSystem);
        this.logger.log(`Soft deleted child system ${childSystem.id}`);
      }
    }

    // Handle equipment connected to this system
    const equipmentSystems = await this.equipmentSystemRepository.find({
      where: { systemId, tenantId },
      relations: ['equipment'],
    });

    if (equipmentSystems.length > 0) {
      this.logger.log(
        `Found ${equipmentSystems.length} equipment(s) connected to system ${systemId}. Setting them as inactive.`
      );

      // Set connected equipment as inactive (shown in red in frontend)
      const equipmentIds = equipmentSystems.map((es) => es.equipmentId);
      await this.equipmentRepository
        .createQueryBuilder()
        .update(Equipment)
        .set({ isActive: false, updatedBy: userId })
        .where('id IN (:...ids)', { ids: equipmentIds })
        .andWhere('tenantId = :tenantId', { tenantId })
        .execute();

      // Delete junction records
      await this.equipmentSystemRepository.delete({ systemId, tenantId });

      this.logger.log(
        `Deactivated ${equipmentIds.length} equipment(s) and removed their system associations`
      );
    }

    // Soft delete the system
    system.softDelete(userId);
    await this.systemRepository.save(system);

    this.logger.log(`System ${systemId} marked as deleted`);

    // Domain event: SystemDeleted
    // await this.eventBus?.publish(new SystemDeletedEvent({
    //   tenantId,
    //   systemId: system.id,
    //   name: system.name,
    //   cascade,
    //   deletedBy: userId,
    // }));

    return true;
  }

  /**
   * Recursively get all child systems
   */
  private async getChildSystemsRecursive(
    parentId: string,
    tenantId: string,
  ): Promise<System[]> {
    const children = await this.systemRepository.find({
      where: { parentSystemId: parentId, tenantId, isDeleted: false },
    });

    let allChildren = [...children];

    for (const child of children) {
      const grandChildren = await this.getChildSystemsRecursive(child.id, tenantId);
      allChildren = [...allChildren, ...grandChildren];
    }

    return allChildren;
  }
}
