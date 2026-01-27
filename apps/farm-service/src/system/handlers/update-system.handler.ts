/**
 * Update System Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { UpdateSystemCommand } from '../commands/update-system.command';
import { System } from '../entities/system.entity';

@CommandHandler(UpdateSystemCommand)
export class UpdateSystemHandler implements ICommandHandler<UpdateSystemCommand> {
  private readonly logger = new Logger(UpdateSystemHandler.name);

  constructor(
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: UpdateSystemCommand): Promise<System> {
    const { input, tenantId, userId } = command;
    const systemId = input.id;

    this.logger.log(`Updating system ${systemId} for tenant ${tenantId}`);

    // Find existing system
    const system = await this.systemRepository.findOne({
      where: { id: systemId, tenantId, isDeleted: false },
    });

    if (!system) {
      throw new NotFoundException(`System with ID "${systemId}" not found`);
    }

    // Check for duplicate code if changing
    if (input.code && input.code !== system.code) {
      const existingByCode = await this.systemRepository.findOne({
        where: { tenantId, siteId: system.siteId, code: input.code, id: Not(systemId) },
      });
      if (existingByCode) {
        throw new ConflictException(`System with code "${input.code}" already exists in this site`);
      }
    }

    // Validate parent system if changing
    if (input.parentSystemId !== undefined) {
      if (input.parentSystemId) {
        // Prevent self-reference
        if (input.parentSystemId === systemId) {
          throw new BadRequestException('A system cannot be its own parent');
        }

        // Verify parent exists
        const parentSystem = await this.systemRepository.findOne({
          where: { id: input.parentSystemId, tenantId, isDeleted: false },
        });
        if (!parentSystem) {
          throw new NotFoundException(`Parent system with ID "${input.parentSystemId}" not found`);
        }

        // Check for circular reference
        await this.checkCircularReference(systemId, input.parentSystemId, tenantId);
      }
    }

    // Update fields
    const updateData: Partial<System> = {
      updatedBy: userId,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.code !== undefined) updateData.code = input.code.toUpperCase();
    if (input.type !== undefined) updateData.type = input.type;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.departmentId !== undefined) updateData.departmentId = input.departmentId;
    if (input.parentSystemId !== undefined) updateData.parentSystemId = input.parentSystemId;
    if (input.totalVolumeM3 !== undefined) updateData.totalVolumeM3 = input.totalVolumeM3;
    if (input.maxBiomassKg !== undefined) updateData.maxBiomassKg = input.maxBiomassKg;
    if (input.tankCount !== undefined) updateData.tankCount = input.tankCount;
    if (input.isActive !== undefined) updateData.isActive = input.isActive;

    Object.assign(system, updateData);

    const updatedSystem = await this.systemRepository.save(system);

    this.logger.log(`System ${systemId} updated successfully`);

    // Domain event: SystemUpdated
    // await this.eventBus?.publish(new SystemUpdatedEvent({
    //   tenantId,
    //   systemId: updatedSystem.id,
    //   name: updatedSystem.name,
    //   code: updatedSystem.code,
    //   updatedBy: userId,
    // }));

    return updatedSystem;
  }

  /**
   * Check for circular reference in parent-child hierarchy
   */
  private async checkCircularReference(
    systemId: string,
    newParentId: string,
    tenantId: string,
  ): Promise<void> {
    let currentParentId: string | null = newParentId;
    const visited = new Set<string>();

    while (currentParentId) {
      if (visited.has(currentParentId)) {
        throw new BadRequestException('Circular reference detected in system hierarchy');
      }
      if (currentParentId === systemId) {
        throw new BadRequestException('This would create a circular reference in the system hierarchy');
      }
      visited.add(currentParentId);

      const parent = await this.systemRepository.findOne({
        where: { id: currentParentId, tenantId },
        select: ['id', 'parentSystemId'],
      });

      currentParentId = parent?.parentSystemId ?? null;
    }
  }
}
