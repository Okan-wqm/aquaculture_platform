import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { UpdateGoalProgressCommand } from '../commands/update-goal-progress.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(UpdateGoalProgressCommand)
export class UpdateGoalProgressHandler implements ICommandHandler<UpdateGoalProgressCommand> {
  private readonly logger = new Logger(UpdateGoalProgressHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateGoalProgressCommand): Promise<Goal> {
    const { tenantId, userId, goalId, progressPercent, keyResultUpdates } = command;

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
        throw new BadRequestException(`Cannot update progress for goal with status ${goal.status}`);
      }

      // Transition to IN_PROGRESS if still NOT_STARTED
      if (goal.status === GoalStatus.NOT_STARTED && progressPercent > 0) {
        goal.status = GoalStatus.IN_PROGRESS;
      }

      goal.progressPercent = progressPercent;
      goal.updatedBy = userId;

      // Update key results if provided
      if (keyResultUpdates && goal.keyResults) {
        for (const update of keyResultUpdates) {
          const kr = goal.keyResults.find((k) => k.id === update.id);
          if (kr) {
            kr.currentValue = update.currentValue;
            kr.isCompleted = kr.currentValue >= kr.targetValue;
          }
        }
      }

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
        `Failed to update goal progress for ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update goal progress');
    } finally {
      await queryRunner.release();
    }
  }
}
