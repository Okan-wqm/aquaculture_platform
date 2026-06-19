import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { UpdateWorkRotationCommand } from '../commands/update-work-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

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
      const repo = tenantManagerRepo(queryRunner.manager, WorkRotation, tenantId);

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

      // MEDIUM: Check for overlapping rotations when dates are being updated
      const effectiveStart = updates.startDate ? new Date(updates.startDate) : rotation.startDate;
      const effectiveEnd = updates.endDate ? new Date(updates.endDate) : rotation.endDate;

      const overlapping = await repo
        .createQueryBuilder('wr')
        .andWhere('wr.employeeId = :employeeId', { employeeId: rotation.employeeId })
        .andWhere('wr.id != :id', { id })
        .andWhere('wr.isDeleted = false')
        .andWhere('wr.status NOT IN (:...excludeStatuses)', {
          excludeStatuses: [RotationStatus.CANCELLED, RotationStatus.COMPLETED],
        })
        .andWhere('wr.startDate < :endDate', { endDate: effectiveEnd })
        .andWhere('wr.endDate > :startDate', { startDate: effectiveStart })
        .getCount();

      if (overlapping > 0) {
        throw new ConflictException(
          'Updated rotation dates overlap with an existing active or scheduled rotation',
        );
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

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
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
