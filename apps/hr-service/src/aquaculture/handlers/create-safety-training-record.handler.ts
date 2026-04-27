import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateSafetyTrainingRecordCommand } from '../commands/create-safety-training-record.command';
import { SafetyTrainingRecord, SafetyTrainingStatus } from '../entities/safety-training-record.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(CreateSafetyTrainingRecordCommand)
export class CreateSafetyTrainingRecordHandler
  implements ICommandHandler<CreateSafetyTrainingRecordCommand, SafetyTrainingRecord>
{
  private readonly logger = new Logger(CreateSafetyTrainingRecordHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreateSafetyTrainingRecordCommand): Promise<SafetyTrainingRecord> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = tenantManagerRepo(queryRunner.manager, SafetyTrainingRecord, tenantId);

      const status = input.completedDate
        ? SafetyTrainingStatus.COMPLETED
        : SafetyTrainingStatus.NOT_STARTED;

      const record = repo.create({
        ...input,
        tenantId,
        status,
        createdBy: userId,
        updatedBy: userId,
      });

      const saved = await repo.save(record);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Safety training record created: ${saved.id} for employee ${input.employeeId}, tenant ${tenantId} by user ${userId}`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      this.logger.error(
        `Failed to create safety training record for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create safety training record');
    } finally {
      await queryRunner.release();
    }
  }
}
