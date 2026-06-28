import { ReviewPeriodType } from '../entities/performance-review.entity';

export interface BulkReviewSpec {
  employeeId: string;
  reviewerId: string;
  periodType: ReviewPeriodType;
  periodStart: string;
  periodEnd: string;
}

export class BulkCreateReviewsCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly reviews: BulkReviewSpec[],
  ) {}
}
