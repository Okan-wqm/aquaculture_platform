import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { StartRotationCommand } from '../commands/start-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';

@Injectable()
@CommandHandler(StartRotationCommand)
export class StartRotationHandler implements ICommandHandler<StartRotationCommand, WorkRotation> {
  private readonly logger = new Logger(StartRotationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: StartRotationCommand): Promise<WorkRotation> {
    const { tenantId, rotationId, userId, actualStartDate } = command;

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

      if (rotation.status !== RotationStatus.SCHEDULED) {
        throw new BadRequestException(
          `Cannot start a rotation with status "${rotation.status}". Only scheduled rotations can be started.`,
        );
      }

      rotation.status = RotationStatus.IN_PROGRESS;
      rotation.actualStartTime = actualStartDate ? new Date(actualStartDate) : new Date();
      rotation.updatedBy = userId;

      const saved = await repo.save(rotation);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Rotation started: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to start rotation ${rotationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to start rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
