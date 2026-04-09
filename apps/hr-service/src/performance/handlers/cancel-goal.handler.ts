import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CancelGoalCommand } from '../commands/cancel-goal.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(CancelGoalCommand)
export class CancelGoalHandler implements ICommandHandler<CancelGoalCommand> {
  private readonly logger = new Logger(CancelGoalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CancelGoalCommand): Promise<Goal> {
    const { tenantId, userId, goalId, reason } = command;

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

      if (goal.status === GoalStatus.COMPLETED) {
        throw new BadRequestException('Cannot cancel a completed goal');
      }

      if (goal.status === GoalStatus.CANCELLED) {
        throw new BadRequestException('Goal is already cancelled');
      }

      goal.status = GoalStatus.CANCELLED;
      goal.updatedBy = userId;
      goal.description = goal.description
        ? `${goal.description}\n\nCancellation Reason: ${reason}`
        : `Cancellation Reason: ${reason}`;

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
        `Failed to cancel goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to cancel goal');
    } finally {
      await queryRunner.release();
    }
  }
}
