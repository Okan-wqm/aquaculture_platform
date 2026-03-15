import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { GetPendingReviewsQuery } from '../queries/get-pending-reviews.query';
import { PerformanceReview, ReviewStatus } from '../entities/performance-review.entity';

@QueryHandler(GetPendingReviewsQuery)
export class GetPendingReviewsHandler implements IQueryHandler<GetPendingReviewsQuery> {
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
  ) {}

  async execute(query: GetPendingReviewsQuery): Promise<PerformanceReview[]> {
    const { tenantId, reviewerId } = query;

    return this.reviewRepository.find({
      where: {
        tenantId,
        reviewerId,
        isDeleted: false,
        status: In([ReviewStatus.MANAGER_REVIEW, ReviewStatus.CALIBRATION]),
      },
      relations: ['employee', 'reviewer'],
      order: { periodEnd: 'DESC' },
    });
  }
}
