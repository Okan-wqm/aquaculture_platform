import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { ConfirmSafetyTrainingAttendanceCommand } from '../commands/confirm-safety-training-attendance.command';
import { SafetyTrainingRecord, SafetyTrainingStatus } from '../entities/safety-training-record.entity';

@Injectable()
@CommandHandler(ConfirmSafetyTrainingAttendanceCommand)
export class ConfirmSafetyTrainingAttendanceHandler
  implements ICommandHandler<ConfirmSafetyTrainingAttendanceCommand, SafetyTrainingRecord>
{
  private readonly logger = new Logger(ConfirmSafetyTrainingAttendanceHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: ConfirmSafetyTrainingAttendanceCommand): Promise<SafetyTrainingRecord> {
    const { tenantId, recordId, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = queryRunner.manager.getRepository(SafetyTrainingRecord);

      const record = await repo.findOne({
        where: { id: recordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!record) {
        throw new NotFoundException(`Safety training record not found: ${recordId}`);
      }

      if (record.status === SafetyTrainingStatus.COMPLETED) {
        // Already completed, just confirm attendance
      } else if (record.status === SafetyTrainingStatus.NOT_STARTED || record.status === SafetyTrainingStatus.IN_PROGRESS) {
        record.status = SafetyTrainingStatus.COMPLETED;
        record.completedDate = new Date();
      } else {
        throw new BadRequestException(
          `Cannot confirm attendance for a training record with status "${record.status}"`,
        );
      }

      record.updatedBy = userId;

      const saved = await repo.save(record);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Safety training attendance confirmed: ${saved.id} for tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to confirm safety training attendance ${recordId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to confirm safety training attendance');
    } finally {
      await queryRunner.release();
    }
  }
}
