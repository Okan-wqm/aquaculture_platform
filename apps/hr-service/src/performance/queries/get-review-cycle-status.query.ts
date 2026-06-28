import { ReviewPeriodType } from '../entities/performance-review.entity';

export class GetReviewCycleStatusQuery {
  constructor(
    public readonly tenantId: string,
    public readonly periodType: ReviewPeriodType,
    public readonly year: number,
  ) {}
}
