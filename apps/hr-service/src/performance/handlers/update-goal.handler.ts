import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { UpdateGoalCommand } from '../commands/update-goal.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(UpdateGoalCommand)
export class UpdateGoalHandler implements ICommandHandler<UpdateGoalCommand> {
  private readonly logger = new Logger(UpdateGoalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateGoalCommand): Promise<Goal> {
    const { tenantId, userId, id, title, description, priority, targetDate, status } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (hr-service): Phase B tenantManagerRepo migration backlog
      const goalRepo = queryRunner.manager.getRepository(Goal);

      const goal = await goalRepo.findOne({
        where: { id, tenantId, isDeleted: false },
      });

      if (!goal) {
        throw new NotFoundException(`Goal with ID ${id} not found`);
      }

      if (goal.status === GoalStatus.COMPLETED || goal.status === GoalStatus.CANCELLED) {
        throw new BadRequestException(`Cannot update goal with status ${goal.status}`);
      }

      if (title !== undefined) goal.title = title;
      if (description !== undefined) goal.description = description;
      if (priority !== undefined) goal.priority = priority;
      if (targetDate !== undefined) goal.targetDate = new Date(targetDate);
      if (status !== undefined) goal.status = status;
      goal.updatedBy = userId;

      await goalRepo.save(goal);

      // Fetch with relations on the SAME connection before commit
      const result = await queryRunner.manager.findOne(Goal, {
        where: { id, tenantId },
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
        `Failed to update goal ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update goal');
    } finally {
      await queryRunner.release();
    }
  }
}
