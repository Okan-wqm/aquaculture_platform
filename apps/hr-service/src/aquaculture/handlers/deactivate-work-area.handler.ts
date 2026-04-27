import { Injectable, NotFoundException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { DeactivateWorkAreaCommand } from '../commands/deactivate-work-area.command';
import { WorkArea } from '../entities/work-area.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(DeactivateWorkAreaCommand)
export class DeactivateWorkAreaHandler implements ICommandHandler<DeactivateWorkAreaCommand, WorkArea> {
  private readonly logger = new Logger(DeactivateWorkAreaHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeactivateWorkAreaCommand): Promise<WorkArea> {
    const { tenantId, workAreaId, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = tenantManagerRepo(queryRunner.manager, WorkArea, tenantId);

      const workArea = await repo.findOne({
        where: { id: workAreaId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!workArea) {
        throw new NotFoundException(`Work area not found: ${workAreaId}`);
      }

      workArea.isActive = false;
      workArea.updatedBy = userId;

      const saved = await repo.save(workArea);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Work area deactivated: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Failed to deactivate work area ${workAreaId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to deactivate work area');
    } finally {
      await queryRunner.release();
    }
  }
}
