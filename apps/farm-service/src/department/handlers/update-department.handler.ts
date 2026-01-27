/**
 * Update Department Command Handler
 */
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConflictException, NotFoundException, Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import { UpdateDepartmentCommand } from '../commands/update-department.command';
import { Department } from '../entities/department.entity';

@CommandHandler(UpdateDepartmentCommand)
export class UpdateDepartmentHandler implements ICommandHandler<UpdateDepartmentCommand> {
  private readonly logger = new Logger(UpdateDepartmentHandler.name);

  constructor(
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  async execute(command: UpdateDepartmentCommand): Promise<Department> {
    const { departmentId, input, tenantId, userId } = command;

    this.logger.log(`Updating department ${departmentId} for tenant ${tenantId}`);

    // Find existing department
    const department = await this.departmentRepository.findOne({
      where: { id: departmentId, tenantId },
    });

    if (!department) {
      throw new NotFoundException(`Department with ID "${departmentId}" not found`);
    }

    // Check for duplicate name if changing
    if (input.name && input.name !== department.name) {
      const existingByName = await this.departmentRepository.findOne({
        where: { tenantId, siteId: department.siteId, name: input.name, id: Not(departmentId) },
      });
      if (existingByName) {
        throw new ConflictException(`Department with name "${input.name}" already exists in this site`);
      }
    }

    // Check for duplicate code if changing
    if (input.code && input.code !== department.code) {
      const existingByCode = await this.departmentRepository.findOne({
        where: { tenantId, code: input.code, id: Not(departmentId) },
      });
      if (existingByCode) {
        throw new ConflictException(`Department with code "${input.code}" already exists`);
      }
    }

    // Update fields
    Object.assign(department, {
      ...input,
      code: input.code ? input.code.toUpperCase() : department.code,
      updatedBy: userId,
    });

    const updatedDepartment = await this.departmentRepository.save(department);

    this.logger.log(`Department ${departmentId} updated successfully`);

    // Domain event: DepartmentUpdated
    // await this.eventBus?.publish(new DepartmentUpdatedEvent({
    //   tenantId,
    //   departmentId: updatedDepartment.id,
    //   name: updatedDepartment.name,
    //   code: updatedDepartment.code,
    //   updatedBy: userId,
    // }));

    return updatedDepartment;
  }
}
