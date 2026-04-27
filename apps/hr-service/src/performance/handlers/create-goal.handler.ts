import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateGoalCommand } from '../commands/create-goal.command';
import { Goal, GoalStatus } from '../entities/goal.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@CommandHandler(CreateGoalCommand)
export class CreateGoalHandler implements ICommandHandler<CreateGoalCommand> {
  private readonly logger = new Logger(CreateGoalHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreateGoalCommand): Promise<Goal> {
    const {
      tenantId,
      userId,
      employeeId,
      title,
      priority,
      startDate,
      targetDate,
      description,
      category,
      keyResults,
      alignedReviewId,
      parentGoalId,
    } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const employeeRepo = tenantManagerRepo(queryRunner.manager, Employee, tenantId);
      const goalRepo = tenantManagerRepo(queryRunner.manager, Goal, tenantId);

      // Validate employee exists
      const employee = await employeeRepo.findOne({
        where: { id: employeeId, tenantId, isDeleted: false },
      });
      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Validate dates
      if (new Date(startDate) >= new Date(targetDate)) {
        throw new BadRequestException('Start date must be before target date');
      }

      // Validate parent goal if provided
      if (parentGoalId) {
        const parentGoal = await goalRepo.findOne({
          where: { id: parentGoalId, tenantId, isDeleted: false },
        });
        if (!parentGoal) {
          throw new NotFoundException(`Parent goal with ID ${parentGoalId} not found`);
        }
      }

      // Build key results with generated IDs
      const mappedKeyResults = keyResults?.map((kr) => ({
        id: randomUUID(),
        description: kr.description,
        targetValue: kr.targetValue,
        currentValue: kr.currentValue || 0,
        unit: kr.unit,
        isCompleted: false,
      }));

      const goal = goalRepo.create({
        tenantId,
        employeeId,
        title,
        description,
        category,
        priority,
        status: GoalStatus.NOT_STARTED,
        startDate: new Date(startDate),
        targetDate: new Date(targetDate),
        progressPercent: 0,
        keyResults: mappedKeyResults,
        alignedReviewId,
        parentGoalId,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedGoal = await goalRepo.save(goal);

      // Reload with relations on the SAME connection before commit
      const result = await queryRunner.manager.findOne(Goal, {
        where: { id: savedGoal.id, tenantId },
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
        `Failed to create goal for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create goal');
    } finally {
      await queryRunner.release();
    }
  }
}
