import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { SubmitManagerAssessmentCommand } from '../commands/submit-manager-assessment.command';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';

@CommandHandler(SubmitManagerAssessmentCommand)
export class SubmitManagerAssessmentHandler implements ICommandHandler<SubmitManagerAssessmentCommand> {
  private readonly logger = new Logger(SubmitManagerAssessmentHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: SubmitManagerAssessmentCommand): Promise<PerformanceReview> {
    const {
      tenantId,
      userId,
      reviewId,
      managerAssessment,
      managerRating,
      competencyRatings,
      strengths,
      areasForImprovement,
      developmentPlan,
    } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (hr-service): Phase B tenantManagerRepo migration backlog
      const reviewRepo = queryRunner.manager.getRepository(PerformanceReview);

      const review = await reviewRepo.findOne({
        where: { id: reviewId, tenantId, isDeleted: false },
      });

      if (!review) {
        throw new NotFoundException(`Performance review with ID ${reviewId} not found`);
      }

      if (review.status !== ReviewStatus.MANAGER_REVIEW) {
        throw new BadRequestException(
          `Cannot submit manager assessment for review with status ${review.status}`,
        );
      }

      review.managerAssessment = managerAssessment;
      review.managerRating = managerRating;
      review.status = ReviewStatus.CALIBRATION;
      review.updatedBy = userId;

      if (strengths) {
        review.strengths = strengths;
      }
      if (areasForImprovement) {
        review.areasForImprovement = areasForImprovement;
      }
      if (developmentPlan) {
        review.developmentPlan = developmentPlan;
      }

      if (competencyRatings) {
        const existingRatings = review.competencyRatings || [];
        review.competencyRatings = competencyRatings.map((cr) => {
          const existing = existingRatings.find((e) => e.competencyId === cr.competencyId);
          return {
            competencyId: cr.competencyId,
            competencyName: existing?.competencyName || cr.competencyId,
            selfRating: existing?.selfRating,
            managerRating: cr.rating,
            finalRating: existing?.finalRating,
            comments: cr.comments || existing?.comments,
          };
        });
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
        `Failed to submit manager assessment for review ${reviewId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to submit manager assessment');
    } finally {
      await queryRunner.release();
    }
  }
}
