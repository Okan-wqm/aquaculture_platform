import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CompleteGoalCommand } from '../commands/complete-goal.command';
import { Goal, GoalStatus } from '../entities/goal.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@CommandHandler(CompleteGoalCommand)
export class CompleteGoalHandler implements ICommandHandler<CompleteGoalCommand> {
  private readonly logger = new Logger(CompleteGoalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CompleteGoalCommand): Promise<Goal> {
    const { tenantId, userId, goalId, completionNotes } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const goalRepo = tenantManagerRepo(queryRunner.manager, Goal, tenantId);

      const goal = await goalRepo.findOne({
        where: { id: goalId, tenantId, isDeleted: false },
      });

      if (!goal) {
        throw new NotFoundException(`Goal with ID ${goalId} not found`);
      }

      if (goal.status === GoalStatus.COMPLETED) {
        throw new BadRequestException('Goal is already completed');
      }

      if (goal.status === GoalStatus.CANCELLED) {
        throw new BadRequestException('Cannot complete a cancelled goal');
      }

      goal.status = GoalStatus.COMPLETED;
      goal.progressPercent = 100;
      goal.completedDate = new Date();
      goal.updatedBy = userId;

      // Mark all key results as completed
      if (goal.keyResults) {
        goal.keyResults = goal.keyResults.map((kr) => ({
          ...kr,
          currentValue: kr.targetValue,
          isCompleted: true,
        }));
      }

      // Mark all milestones as completed
      if (goal.milestones) {
        const now = new Date().toISOString().split('T')[0];
        goal.milestones = goal.milestones.map((m) => ({
          ...m,
          isCompleted: true,
          completedDate: m.completedDate || now,
        }));
      }

      if (completionNotes) {
        goal.description = goal.description
          ? `${goal.description}\n\nCompletion Notes: ${completionNotes}`
          : `Completion Notes: ${completionNotes}`;
      }

      await goalRepo.save(goal);

      // Fetch with relations on the SAME connection before commit
      const result = await queryRunner.manager.findOne(Goal, {
        where: { id: goalId, tenantId },
        relations: ['employee', 'parentGoal', 'childGoals'],
      });

      await queryRunner.commitTransaction();

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to complete goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to complete goal');
    } finally {
      await queryRunner.release();
    }
  }
}
