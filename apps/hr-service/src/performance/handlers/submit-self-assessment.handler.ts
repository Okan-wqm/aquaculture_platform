import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { SubmitSelfAssessmentCommand } from '../commands/submit-self-assessment.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';

@CommandHandler(SubmitSelfAssessmentCommand)
export class SubmitSelfAssessmentHandler implements ICommandHandler<SubmitSelfAssessmentCommand> {
  private readonly logger = new Logger(SubmitSelfAssessmentHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: SubmitSelfAssessmentCommand): Promise<PerformanceReview> {
    const { tenantId, userId, reviewId, selfAssessment, selfRating, competencyRatings } = command;

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

      if (review.status !== ReviewStatus.DRAFT && review.status !== ReviewStatus.SELF_ASSESSMENT) {
        throw new BadRequestException(
          `Cannot submit self assessment for review with status ${review.status}`,
        );
      }

      review.selfAssessment = selfAssessment;
      review.selfRating = selfRating;
      review.status = ReviewStatus.MANAGER_REVIEW;
      review.updatedBy = userId;

      if (competencyRatings) {
        const existingRatings = review.competencyRatings || [];
        review.competencyRatings = competencyRatings.map((cr) => {
          const existing = existingRatings.find((e) => e.competencyId === cr.competencyId);
          return {
            competencyId: cr.competencyId,
            competencyName: existing?.competencyName || cr.competencyId,
            selfRating: cr.rating,
            managerRating: existing?.managerRating,
            finalRating: existing?.finalRating,
            comments: cr.comments || existing?.comments,
          };
        });
      }

      await reviewRepo.save(review);

      // Reload with relations on the SAME connection before commit
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
        `Failed to submit self assessment for review ${reviewId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to submit self assessment');
    } finally {
      await queryRunner.release();
    }
  }
}
