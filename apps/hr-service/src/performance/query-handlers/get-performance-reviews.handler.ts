import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPerformanceReviewsQuery } from '../queries/get-performance-reviews.query';
import { PerformanceReview } from '../entities/performance-review.entity';

@QueryHandler(GetPerformanceReviewsQuery)
export class GetPerformanceReviewsHandler implements IQueryHandler<GetPerformanceReviewsQuery> {
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
  ) {}

  async execute(query: GetPerformanceReviewsQuery): Promise<PaginatedQueryResult<PerformanceReview>> {
    const { tenantId, employeeId, status } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const qb = this.reviewRepository
      .createQueryBuilder('pr')
      .leftJoinAndSelect('pr.employee', 'employee')
      .leftJoinAndSelect('pr.reviewer', 'reviewer')
      .where('pr.tenantId = :tenantId', { tenantId })
      .andWhere('pr.isDeleted = false')
      .orderBy('pr.periodEnd', 'DESC')
      .addOrderBy('pr.createdAt', 'DESC');

    if (employeeId) {
      qb.andWhere('pr.employeeId = :employeeId', { employeeId });
    }

    if (status) {
      qb.andWhere('pr.status = :status', { status });
    }

    const [items, total] = await qb
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
