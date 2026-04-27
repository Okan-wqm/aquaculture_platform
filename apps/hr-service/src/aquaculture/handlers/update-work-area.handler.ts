import { Injectable, NotFoundException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { UpdateWorkAreaCommand } from '../commands/update-work-area.command';
import { WorkArea } from '../entities/work-area.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(UpdateWorkAreaCommand)
export class UpdateWorkAreaHandler implements ICommandHandler<UpdateWorkAreaCommand, WorkArea> {
  private readonly logger = new Logger(UpdateWorkAreaHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateWorkAreaCommand): Promise<WorkArea> {
    const { tenantId, input, userId } = command;
    const { id, ...updates } = input;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = tenantManagerRepo(queryRunner.manager, WorkArea, tenantId);

      const workArea = await repo.findOne({
        where: { id, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!workArea) {
        throw new NotFoundException(`Work area not found: ${id}`);
      }

      // Apply updates
      Object.assign(workArea, updates, { updatedBy: userId });

      const saved = await repo.save(workArea);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Work area updated: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Failed to update work area ${id} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update work area');
    } finally {
      await queryRunner.release();
    }
  }
}
