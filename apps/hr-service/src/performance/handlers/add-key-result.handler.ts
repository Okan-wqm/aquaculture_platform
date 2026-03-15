import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AddKeyResultCommand } from '../commands/add-key-result.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(AddKeyResultCommand)
export class AddKeyResultHandler implements ICommandHandler<AddKeyResultCommand> {
  private readonly logger = new Logger(AddKeyResultHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: AddKeyResultCommand): Promise<Goal> {
    const { tenantId, userId, goalId, keyResult } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const goalRepo = queryRunner.manager.getRepository(Goal);

      const goal = await goalRepo.findOne({
        where: { id: goalId, tenantId, isDeleted: false },
      });

      if (!goal) {
        throw new NotFoundException(`Goal with ID ${goalId} not found`);
      }

      if (goal.status === GoalStatus.COMPLETED || goal.status === GoalStatus.CANCELLED) {
        throw new BadRequestException(`Cannot add key result to goal with status ${goal.status}`);
      }

      const newKeyResult = {
        id: randomUUID(),
        description: keyResult.description,
        targetValue: keyResult.targetValue,
        currentValue: keyResult.currentValue || 0,
        unit: keyResult.unit,
        isCompleted: false,
      };

      goal.keyResults = [...(goal.keyResults || []), newKeyResult];
      goal.updatedBy = userId;

      await goalRepo.save(goal);
      await queryRunner.commitTransaction();

      const result = await this.dataSource.getRepository(Goal).findOne({
        where: { id: goalId, tenantId },
        relations: ['employee', 'parentGoal', 'childGoals'],
      });

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to add key result to goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to add key result');
    } finally {
      await queryRunner.release();
    }
  }
}
