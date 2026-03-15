import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DeferGoalCommand } from '../commands/defer-goal.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(DeferGoalCommand)
export class DeferGoalHandler implements ICommandHandler<DeferGoalCommand> {
  private readonly logger = new Logger(DeferGoalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeferGoalCommand): Promise<Goal> {
    const { tenantId, userId, goalId, newTargetDate, reason } = command;

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
        throw new BadRequestException(`Cannot defer goal with status ${goal.status}`);
      }

      goal.status = GoalStatus.DEFERRED;
      goal.targetDate = new Date(newTargetDate);
      goal.updatedBy = userId;

      if (reason) {
        goal.description = goal.description
          ? `${goal.description}\n\nDeferred: ${reason}`
          : `Deferred: ${reason}`;
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
        `Failed to defer goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to defer goal');
    } finally {
      await queryRunner.release();
    }
  }
}
