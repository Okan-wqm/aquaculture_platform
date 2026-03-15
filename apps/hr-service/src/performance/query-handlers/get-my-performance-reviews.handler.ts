import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetMyPerformanceReviewsQuery } from '../queries/get-my-performance-reviews.query';
import { PerformanceReview } from '../entities/performance-review.entity';

@QueryHandler(GetMyPerformanceReviewsQuery)
export class GetMyPerformanceReviewsHandler implements IQueryHandler<GetMyPerformanceReviewsQuery> {
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
  ) {}

  async execute(query: GetMyPerformanceReviewsQuery): Promise<PerformanceReview[]> {
    const { tenantId, userId, status } = query;

    const qb = this.reviewRepository
      .createQueryBuilder('pr')
      .leftJoinAndSelect('pr.employee', 'employee')
      .leftJoinAndSelect('pr.reviewer', 'reviewer')
      .where('pr.tenantId = :tenantId', { tenantId })
      .andWhere('pr.employeeId = :userId', { userId })
      .andWhere('pr.isDeleted = false')
      .orderBy('pr.periodEnd', 'DESC');

    if (status) {
      qb.andWhere('pr.status = :status', { status });
    }

    return qb.getMany();
  }
}
