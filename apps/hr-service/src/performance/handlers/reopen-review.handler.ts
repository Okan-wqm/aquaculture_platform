import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { ReopenReviewCommand } from '../commands/reopen-review.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@CommandHandler(ReopenReviewCommand)
export class ReopenReviewHandler implements ICommandHandler<ReopenReviewCommand> {
  private readonly logger = new Logger(ReopenReviewHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: ReopenReviewCommand): Promise<PerformanceReview> {
    const { tenantId, userId, reviewId, reason } = command;

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

      if (review.status !== ReviewStatus.FINALIZED && review.status !== ReviewStatus.ACKNOWLEDGED) {
        throw new BadRequestException(
          `Cannot reopen review with status ${review.status}`,
        );
      }

      review.status = ReviewStatus.MANAGER_REVIEW;
      review.finalRating = undefined;
      review.finalizedBy = undefined;
      review.finalizedAt = undefined;
      review.acknowledgedBy = undefined;
      review.acknowledgedAt = undefined;
      review.calibrationNotes = review.calibrationNotes
        ? `${review.calibrationNotes}; Reopened: ${reason}`
        : `Reopened: ${reason}`;
      review.updatedBy = userId;

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
        `Failed to reopen review ${reviewId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to reopen review');
    } finally {
      await queryRunner.release();
    }
  }
}
