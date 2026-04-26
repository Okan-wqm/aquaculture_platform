import { Injectable, NotFoundException, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { UpdateDepartmentCommand } from '../commands/update-department.command';
import { DepartmentHR } from '../entities/department.entity';

@Injectable()
@CommandHandler(UpdateDepartmentCommand)
export class UpdateDepartmentHandler implements ICommandHandler<UpdateDepartmentCommand, DepartmentHR> {
  private readonly logger = new Logger(UpdateDepartmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: UpdateDepartmentCommand): Promise<DepartmentHR> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (hr-service): Phase B tenantManagerRepo migration backlog
      const repo = queryRunner.manager.getRepository(DepartmentHR);

      const department = await repo.findOne({
        where: { tenantId, id: input.id },
      });

      if (!department) {
        throw new NotFoundException(`Department ${input.id} not found`);
      }

      // Check for duplicate code if code is being changed
      if (input.code && input.code !== department.code) {
        const existing = await repo.findOne({
          where: { tenantId, code: input.code, isDeleted: false },
        });
        if (existing) {
          throw new ConflictException(`Department with code '${input.code}' already exists`);
        }
      }

      // Validate parent department if specified
      if (input.parentDepartmentId) {
        if (input.parentDepartmentId === input.id) {
          throw new ConflictException('Department cannot be its own parent');
        }
        const parent = await repo.findOne({
          where: { tenantId, id: input.parentDepartmentId, isDeleted: false },
        });
        if (!parent) {
          throw new ConflictException('Parent department not found');
        }
      }

      // Handle soft delete
      if (input.isDeleted) {
        department.isDeleted = true;
        department.deletedAt = new Date();
        department.deletedBy = userId;
      }

      // Apply updates
      const { id: _id, isDeleted: _isDeleted, ...updates } = input;
      Object.assign(department, updates);
      department.updatedBy = userId;

      const saved = await repo.save(department);
      await queryRunner.commitTransaction();

      this.logger.log(`Department updated: ${saved.id} for tenant ${tenantId}`);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to update department for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to update department');
    } finally {
      await queryRunner.release();
    }
  }
}
