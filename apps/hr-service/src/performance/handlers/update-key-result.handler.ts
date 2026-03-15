import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { UpdateKeyResultCommand } from '../commands/update-key-result.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(UpdateKeyResultCommand)
export class UpdateKeyResultHandler implements ICommandHandler<UpdateKeyResultCommand> {
  private readonly logger = new Logger(UpdateKeyResultHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateKeyResultCommand): Promise<Goal> {
    const { tenantId, userId, goalId, keyResultId, currentValue } = command;

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
        throw new BadRequestException(`Cannot update key result for goal with status ${goal.status}`);
      }

      if (!goal.keyResults) {
        throw new BadRequestException('Goal has no key results');
      }

      const kr = goal.keyResults.find((k) => k.id === keyResultId);
      if (!kr) {
        throw new NotFoundException(`Key result with ID ${keyResultId} not found`);
      }

      kr.currentValue = currentValue;
      kr.isCompleted = currentValue >= kr.targetValue;

      // Recalculate progress based on key results
      const totalKRs = goal.keyResults.length;
      const completedKRs = goal.keyResults.filter((k) => k.isCompleted).length;
      goal.progressPercent = totalKRs > 0 ? Math.round((completedKRs / totalKRs) * 100) : goal.progressPercent;
      goal.updatedBy = userId;

      // Auto-transition to IN_PROGRESS
      if (goal.status === GoalStatus.NOT_STARTED && goal.progressPercent > 0) {
        goal.status = GoalStatus.IN_PROGRESS;
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
        `Failed to update key result for goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update key result');
    } finally {
      await queryRunner.release();
    }
  }
}
