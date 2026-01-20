/**
 * Create System Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { CreateSystemCommand } from '../commands/create-system.command';
import { System, SystemStatus } from '../entities/system.entity';
import { Site } from '../../site/entities/site.entity';
import { Department } from '../../department/entities/department.entity';

@CommandHandler(CreateSystemCommand)
export class CreateSystemHandler implements ICommandHandler<CreateSystemCommand> {
  private readonly logger = new Logger(CreateSystemHandler.name);

  constructor(
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
  ) {}

  async execute(command: CreateSystemCommand): Promise<System> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating system "${input.name}" for tenant ${tenantId}`);

    // Verify site exists and belongs to tenant
    const site = await this.siteRepository.findOne({
      where: { id: input.siteId, tenantId },
    });
    if (!site) {
      throw new NotFoundException(`Site with ID "${input.siteId}" not found`);
    }

    // Verify department exists if provided
    if (input.departmentId) {
      const department = await this.departmentRepository.findOne({
        where: { id: input.departmentId, tenantId },
      });
      if (!department) {
        throw new NotFoundException(`Department with ID "${input.departmentId}" not found`);
      }
      if (department.siteId !== input.siteId) {
        throw new BadRequestException(
          `Department with ID "${input.departmentId}" does not belong to Site "${input.siteId}"`
        );
      }
    }

    // Verify parent system exists if provided
    if (input.parentSystemId) {
      const parentSystem = await this.systemRepository.findOne({
        where: { id: input.parentSystemId, tenantId },
      });
      if (!parentSystem) {
        throw new NotFoundException(`Parent system with ID "${input.parentSystemId}" not found`);
      }
      if (parentSystem.siteId !== input.siteId) {
        throw new BadRequestException(
          `Parent system with ID "${input.parentSystemId}" does not belong to Site "${input.siteId}"`
        );
      }
      if (
        input.departmentId &&
        parentSystem.departmentId &&
        parentSystem.departmentId !== input.departmentId
      ) {
        throw new BadRequestException(
          `Parent system with ID "${input.parentSystemId}" does not belong to Department "${input.departmentId}"`
        );
      }
    }

    const normalizedCode = input.code.toUpperCase();

    // Check for duplicate code within tenant and site
    const existingByCode = await this.systemRepository.findOne({
      where: { tenantId, siteId: input.siteId, code: normalizedCode },
    });
    if (existingByCode) {
      throw new ConflictException(`System with code "${normalizedCode}" already exists in this site`);
    }

    // Create system entity
    const system = this.systemRepository.create({
      tenantId,
      siteId: input.siteId,
      departmentId: input.departmentId,
      parentSystemId: input.parentSystemId,
      name: input.name,
      code: normalizedCode,
      type: input.type,
      status: input.status ?? SystemStatus.OPERATIONAL,
      description: input.description,
      totalVolumeM3: input.totalVolumeM3,
      maxBiomassKg: input.maxBiomassKg,
      tankCount: input.tankCount,
      isActive: true,
      isDeleted: false,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedSystem = await this.systemRepository.save(system);

    this.logger.log(`System "${savedSystem.name}" created with ID ${savedSystem.id}`);

    // TODO: Publish SystemCreated event

    return savedSystem;
  }
}
