import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { UpdateWorkRotationCommand } from '../commands/update-work-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';

@Injectable()
@CommandHandler(UpdateWorkRotationCommand)
export class UpdateWorkRotationHandler implements ICommandHandler<UpdateWorkRotationCommand, WorkRotation> {
  private readonly logger = new Logger(UpdateWorkRotationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateWorkRotationCommand): Promise<WorkRotation> {
    const { tenantId, input, userId } = command;
    const { id, ...updates } = input;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = queryRunner.manager.getRepository(WorkRotation);

      const rotation = await repo.findOne({
        where: { id, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!rotation) {
        throw new NotFoundException(`Work rotation not found: ${id}`);
      }

      // Only allow updates to scheduled rotations (not completed/cancelled)
      if (rotation.status === RotationStatus.COMPLETED || rotation.status === RotationStatus.CANCELLED) {
        throw new BadRequestException(
          `Cannot update a rotation with status "${rotation.status}"`,
        );
      }

      // Validate dates if being updated
      if (updates.startDate && updates.endDate) {
        if (new Date(updates.endDate) <= new Date(updates.startDate)) {
          throw new BadRequestException('End date must be after start date');
        }
      } else if (updates.endDate && new Date(updates.endDate) <= rotation.startDate) {
        throw new BadRequestException('End date must be after start date');
      } else if (updates.startDate && rotation.endDate <= new Date(updates.startDate)) {
        throw new BadRequestException('Start date must be before end date');
      }

      Object.assign(rotation, updates, { updatedBy: userId });

      const saved = await repo.save(rotation);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Work rotation updated: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to update work rotation ${id} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update work rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
