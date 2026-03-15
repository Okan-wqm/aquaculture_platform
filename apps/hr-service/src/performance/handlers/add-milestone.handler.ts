import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AddMilestoneCommand } from '../commands/add-milestone.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(AddMilestoneCommand)
export class AddMilestoneHandler implements ICommandHandler<AddMilestoneCommand> {
  private readonly logger = new Logger(AddMilestoneHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: AddMilestoneCommand): Promise<Goal> {
    const { tenantId, userId, goalId, milestone } = command;

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
        throw new BadRequestException(`Cannot add milestone to goal with status ${goal.status}`);
      }

      const newMilestone = {
        id: randomUUID(),
        title: milestone.title,
        targetDate: milestone.targetDate,
        isCompleted: false,
      };

      goal.milestones = [...(goal.milestones || []), newMilestone];
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
        `Failed to add milestone to goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to add milestone');
    } finally {
      await queryRunner.release();
    }
  }
}
