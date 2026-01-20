/**
 * Create Department Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { CreateDepartmentCommand } from '../commands/create-department.command';
import { Department, DepartmentStatus } from '../entities/department.entity';
import { Site } from '../../site/entities/site.entity';

@CommandHandler(CreateDepartmentCommand)
export class CreateDepartmentHandler implements ICommandHandler<CreateDepartmentCommand> {
  private readonly logger = new Logger(CreateDepartmentHandler.name);

  constructor(
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async execute(command: CreateDepartmentCommand): Promise<Department> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating department "${input.name}" for tenant ${tenantId}`);

    // Verify site exists and belongs to tenant
    const site = await this.siteRepository.findOne({
      where: { id: input.siteId, tenantId },
    });
    if (!site) {
      throw new NotFoundException(`Site with ID "${input.siteId}" not found`);
    }

    // Check for duplicate name within site
    const existingByName = await this.departmentRepository.findOne({
      where: { tenantId, siteId: input.siteId, name: input.name },
    });
    if (existingByName) {
      throw new ConflictException(`Department with name "${input.name}" already exists in this site`);
    }

    // Check for duplicate code within tenant
    const existingByCode = await this.departmentRepository.findOne({
      where: { tenantId, code: input.code },
    });
    if (existingByCode) {
      throw new ConflictException(`Department with code "${input.code}" already exists`);
    }

    // Create department entity - aligned with Department entity
    const department = this.departmentRepository.create({
      tenantId,
      siteId: input.siteId,
      name: input.name,
      code: input.code.toUpperCase(),
      type: input.type,
      description: input.description,
      capacity: input.capacity,
      notes: input.notes,
      status: DepartmentStatus.ACTIVE,
      managerUserId: input.managerId,
      managerName: input.managerName,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedDepartment = await this.departmentRepository.save(department);

    this.logger.log(`Department "${savedDepartment.name}" created with ID ${savedDepartment.id}`);

    // TODO: Publish DepartmentCreated event

    return savedDepartment;
  }
}
