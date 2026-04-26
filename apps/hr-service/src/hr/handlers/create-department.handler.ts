import { Injectable, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateDepartmentCommand } from '../commands/create-department.command';
import { DepartmentHR } from '../entities/department.entity';

@Injectable()
@CommandHandler(CreateDepartmentCommand)
export class CreateDepartmentHandler implements ICommandHandler<CreateDepartmentCommand, DepartmentHR> {
  private readonly logger = new Logger(CreateDepartmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateDepartmentCommand): Promise<DepartmentHR> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (hr-service): Phase B tenantManagerRepo migration backlog
      const repo = queryRunner.manager.getRepository(DepartmentHR);

      // Check for duplicate code within tenant
      const existing = await repo.findOne({
        where: { tenantId, code: input.code, isDeleted: false },
      });

      if (existing) {
        throw new ConflictException(`Department with code '${input.code}' already exists`);
      }

      // Validate parent department if specified
      if (input.parentDepartmentId) {
        const parent = await repo.findOne({
          where: { tenantId, id: input.parentDepartmentId, isDeleted: false },
        });
        if (!parent) {
          throw new ConflictException('Parent department not found');
        }
      }

      const department = repo.create({
        ...input,
        tenantId,
        createdBy: userId,
        updatedBy: userId,
      });

      const saved = await repo.save(department);
      await queryRunner.commitTransaction();

      this.logger.log(`Department created: ${saved.id} (${saved.code}) for tenant ${tenantId}`);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to create department for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to create department');
    } finally {
      await queryRunner.release();
    }
  }
}
