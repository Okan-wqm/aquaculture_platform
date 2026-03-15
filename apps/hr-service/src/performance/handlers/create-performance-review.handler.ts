import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CreatePerformanceReviewCommand } from '../commands/create-performance-review.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { Employee } from '../../hr/entities/employee.entity';

@CommandHandler(CreatePerformanceReviewCommand)
export class CreatePerformanceReviewHandler implements ICommandHandler<CreatePerformanceReviewCommand> {
  private readonly logger = new Logger(CreatePerformanceReviewHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreatePerformanceReviewCommand): Promise<PerformanceReview> {
    const { tenantId, userId, employeeId, reviewerId, periodType, periodStart, periodEnd } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const employeeRepo = queryRunner.manager.getRepository(Employee);
      const reviewRepo = queryRunner.manager.getRepository(PerformanceReview);

      // Validate employee exists
      const employee = await employeeRepo.findOne({
        where: { id: employeeId, tenantId, isDeleted: false },
      });
      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Validate reviewer exists
      const reviewer = await employeeRepo.findOne({
        where: { id: reviewerId, tenantId, isDeleted: false },
      });
      if (!reviewer) {
        throw new NotFoundException(`Reviewer with ID ${reviewerId} not found`);
      }

      // Validate period
      if (new Date(periodStart) >= new Date(periodEnd)) {
        throw new BadRequestException('Period start must be before period end');
      }

      const review = reviewRepo.create({
        tenantId,
        employeeId,
        reviewerId,
        periodType,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        status: ReviewStatus.DRAFT,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedReview = await reviewRepo.save(review);
      await queryRunner.commitTransaction();

      // Reload with relations
      const result = await this.dataSource.getRepository(PerformanceReview).findOne({
        where: { id: savedReview.id, tenantId },
        relations: ['employee', 'reviewer'],
      });

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to create performance review for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create performance review');
    } finally {
      await queryRunner.release();
    }
  }
}
