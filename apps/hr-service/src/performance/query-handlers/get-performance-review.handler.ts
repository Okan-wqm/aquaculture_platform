import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetPerformanceReviewQuery } from '../queries/get-performance-review.query';
import { PerformanceReview } from '../entities/performance-review.entity';

@QueryHandler(GetPerformanceReviewQuery)
export class GetPerformanceReviewHandler implements IQueryHandler<GetPerformanceReviewQuery> {
  constructor(
    @InjectRepository(PerformanceReview)
    private readonly reviewRepository: Repository<PerformanceReview>,
  ) {}

  async execute(query: GetPerformanceReviewQuery): Promise<PerformanceReview> {
    const { tenantId, id } = query;

    const review = await this.reviewRepository.findOne({
      where: { id, tenantId, isDeleted: false },
      relations: ['employee', 'reviewer'],
    });

    if (!review) {
      throw new NotFoundException(`Performance review with ID ${id} not found`);
    }

    return review;
  }
}
