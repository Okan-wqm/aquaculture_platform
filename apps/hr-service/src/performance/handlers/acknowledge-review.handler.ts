import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { AcknowledgeReviewCommand } from '../commands/acknowledge-review.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@CommandHandler(AcknowledgeReviewCommand)
export class AcknowledgeReviewHandler implements ICommandHandler<AcknowledgeReviewCommand> {
  private readonly logger = new Logger(AcknowledgeReviewHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: AcknowledgeReviewCommand): Promise<PerformanceReview> {
    const { tenantId, userId, reviewId, comments } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const reviewRepo = tenantManagerRepo(queryRunner.manager, PerformanceReview, tenantId);

      const review = await reviewRepo.findOne({
        where: { id: reviewId, tenantId, isDeleted: false },
      });

      if (!review) {
        throw new NotFoundException(`Performance review with ID ${reviewId} not found`);
      }

      if (review.status !== ReviewStatus.FINALIZED) {
        throw new BadRequestException(
          `Cannot acknowledge review with status ${review.status}`,
        );
      }

      review.status = ReviewStatus.ACKNOWLEDGED;
      review.acknowledgedBy = userId;
      review.acknowledgedAt = new Date();
      review.updatedBy = userId;

      if (comments) {
        review.employeeComments = comments;
      }

      await reviewRepo.save(review);

      // Fetch with relations on the SAME connection before commit
      const result = await queryRunner.manager.findOne(PerformanceReview, {
        where: { id: reviewId, tenantId },
        relations: ['employee', 'reviewer'],
      });

      await queryRunner.commitTransaction();

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to acknowledge review ${reviewId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to acknowledge review');
    } finally {
      await queryRunner.release();
    }
  }
}
