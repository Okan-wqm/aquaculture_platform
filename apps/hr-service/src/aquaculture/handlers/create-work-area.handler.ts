import { Injectable, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateWorkAreaCommand } from '../commands/create-work-area.command';
import { WorkArea } from '../entities/work-area.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(CreateWorkAreaCommand)
export class CreateWorkAreaHandler implements ICommandHandler<CreateWorkAreaCommand, WorkArea> {
  private readonly logger = new Logger(CreateWorkAreaHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreateWorkAreaCommand): Promise<WorkArea> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const repo = tenantManagerRepo(queryRunner.manager, WorkArea, tenantId);

      // Check for duplicate code within tenant
      const existing = await repo.findOne({
        where: { tenantId, code: input.code },
        lock: { mode: 'pessimistic_read' },
      });

      if (existing) {
        throw new ConflictException(`A work area with code "${input.code}" already exists`);
      }

      const workArea = repo.create({
        ...input,
        tenantId,
        createdBy: userId,
        updatedBy: userId,
      });

      const saved = await repo.save(workArea);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Work area created: ${saved.id} (${saved.code}) for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to create work area for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create work area');
    } finally {
      await queryRunner.release();
    }
  }
}
