import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { CancelRotationCommand } from '../commands/cancel-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';

@Injectable()
@CommandHandler(CancelRotationCommand)
export class CancelRotationHandler implements ICommandHandler<CancelRotationCommand, WorkRotation> {
  private readonly logger = new Logger(CancelRotationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CancelRotationCommand): Promise<WorkRotation> {
    const { tenantId, rotationId, userId, reason } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = queryRunner.manager.getRepository(WorkRotation);

      const rotation = await repo.findOne({
        where: { id: rotationId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!rotation) {
        throw new NotFoundException(`Work rotation not found: ${rotationId}`);
      }

      if (rotation.status === RotationStatus.COMPLETED || rotation.status === RotationStatus.CANCELLED) {
        throw new BadRequestException(
          `Cannot cancel a rotation with status "${rotation.status}"`,
        );
      }

      rotation.status = RotationStatus.CANCELLED;
      rotation.notes = rotation.notes
        ? `${rotation.notes}\n---\nCancellation reason: ${reason}`
        : `Cancellation reason: ${reason}`;
      rotation.updatedBy = userId;

      const saved = await repo.save(rotation);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Rotation cancelled: ${saved.id} for tenant ${tenantId} by user ${userId}. Reason: ${reason}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to cancel rotation ${rotationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to cancel rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
