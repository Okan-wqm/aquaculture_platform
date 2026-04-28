import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { ApproveRotationCommand } from '../commands/approve-rotation.command';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(ApproveRotationCommand)
export class ApproveRotationHandler implements ICommandHandler<ApproveRotationCommand, WorkRotation> {
  private readonly logger = new Logger(ApproveRotationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: ApproveRotationCommand): Promise<WorkRotation> {
    const { tenantId, rotationId, userId, notes } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = tenantManagerRepo(queryRunner.manager, WorkRotation, tenantId);

      const rotation = await repo.findOne({
        where: { id: rotationId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!rotation) {
        throw new NotFoundException(`Work rotation not found: ${rotationId}`);
      }

      if (rotation.status !== RotationStatus.SCHEDULED) {
        throw new BadRequestException(
          `Cannot approve a rotation with status "${rotation.status}". Only scheduled rotations can be approved.`,
        );
      }

      // Approval keeps status as SCHEDULED but records the approver
      if (notes) {
        rotation.notes = rotation.notes
          ? `${rotation.notes}\n---\nApproval notes: ${notes}`
          : `Approval notes: ${notes}`;
      }
      rotation.updatedBy = userId;

      const saved = await repo.save(rotation);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Rotation approved: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to approve rotation ${rotationId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to approve rotation');
    } finally {
      await queryRunner.release();
    }
  }
}
