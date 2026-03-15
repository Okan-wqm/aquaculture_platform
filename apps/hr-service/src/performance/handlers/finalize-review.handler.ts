import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { FinalizeReviewCommand } from '../commands/finalize-review.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';

@CommandHandler(FinalizeReviewCommand)
export class FinalizeReviewHandler implements ICommandHandler<FinalizeReviewCommand> {
  private readonly logger = new Logger(FinalizeReviewHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: FinalizeReviewCommand): Promise<PerformanceReview> {
    const { tenantId, userId, reviewId, finalRating, calibrationNotes, reviewerComments } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const reviewRepo = queryRunner.manager.getRepository(PerformanceReview);

      const review = await reviewRepo.findOne({
        where: { id: reviewId, tenantId, isDeleted: false },
      });

      if (!review) {
        throw new NotFoundException(`Performance review with ID ${reviewId} not found`);
      }

      if (review.status !== ReviewStatus.CALIBRATION) {
        throw new BadRequestException(
          `Cannot finalize review with status ${review.status}`,
        );
      }

      review.finalRating = finalRating;
      review.status = ReviewStatus.FINALIZED;
      review.finalizedBy = userId;
      review.finalizedAt = new Date();
      review.updatedBy = userId;

      if (calibrationNotes) {
        review.calibrationNotes = calibrationNotes;
      }
      if (reviewerComments) {
        review.reviewerComments = reviewerComments;
      }

      // Set final ratings on competencies if they exist
      if (review.competencyRatings) {
        review.competencyRatings = review.competencyRatings.map((cr) => ({
          ...cr,
          finalRating: cr.finalRating ?? cr.managerRating ?? cr.selfRating,
        }));
      }

      await reviewRepo.save(review);
      await queryRunner.commitTransaction();

      const result = await this.dataSource.getRepository(PerformanceReview).findOne({
        where: { id: reviewId, tenantId },
        relations: ['employee', 'reviewer'],
      });

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to finalize review ${reviewId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to finalize review');
    } finally {
      await queryRunner.release();
    }
  }
}
