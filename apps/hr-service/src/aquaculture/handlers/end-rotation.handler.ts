import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { EndRotationCommand } from '../commands/end-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';

@Injectable()
@CommandHandler(EndRotationCommand)
export class EndRotationHandler implements ICommandHandler<EndRotationCommand, WorkRotation> {
  private readonly logger = new Logger(EndRotationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: EndRotationCommand): Promise<WorkRotation> {
    const { tenantId, rotationId, userId, actualEndDate, notes } = command;

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

      if (rotation.status !== RotationStatus.IN_PROGRESS && rotation.status !== RotationStatus.EXTENDED) {
        throw new BadRequestException(
          `Cannot end a rotation with status "${rotation.status}". Only in-progress or extended rotations can be ended.`,
        );
      }

      rotation.status = RotationStatus.COMPLETED;
      rotation.actualEndTime = actualEndDate ? new Date(actualEndDate) : new Date();
      if (notes) {
        rotation.notes = rotation.notes ? `${rotation.notes}\n---\n${notes}` : notes;
      }
      rotation.updatedBy = userId;

      const saved = await repo.save(rotation);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Rotation ended: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to end rotation ${rotationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to end rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
