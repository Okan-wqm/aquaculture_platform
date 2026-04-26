import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CompleteMilestoneCommand } from '../commands/complete-milestone.command';
import { Goal, GoalStatus } from '../entities/goal.entity';

@CommandHandler(CompleteMilestoneCommand)
export class CompleteMilestoneHandler implements ICommandHandler<CompleteMilestoneCommand> {
  private readonly logger = new Logger(CompleteMilestoneHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CompleteMilestoneCommand): Promise<Goal> {
    const { tenantId, userId, goalId, milestoneId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (hr-service): Phase B tenantManagerRepo migration backlog
      const goalRepo = queryRunner.manager.getRepository(Goal);

      const goal = await goalRepo.findOne({
        where: { id: goalId, tenantId, isDeleted: false },
      });

      if (!goal) {
        throw new NotFoundException(`Goal with ID ${goalId} not found`);
      }

      if (goal.status === GoalStatus.COMPLETED || goal.status === GoalStatus.CANCELLED) {
        throw new BadRequestException(`Cannot complete milestone for goal with status ${goal.status}`);
      }

      if (!goal.milestones) {
        throw new BadRequestException('Goal has no milestones');
      }

      const milestone = goal.milestones.find((m) => m.id === milestoneId);
      if (!milestone) {
        throw new NotFoundException(`Milestone with ID ${milestoneId} not found`);
      }

      if (milestone.isCompleted) {
        throw new BadRequestException('Milestone is already completed');
      }

      milestone.isCompleted = true;
      milestone.completedDate = new Date().toISOString().split('T')[0];
      goal.updatedBy = userId;

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
        `Failed to complete milestone for goal ${goalId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to complete milestone');
    } finally {
      await queryRunner.release();
    }
  }
}
