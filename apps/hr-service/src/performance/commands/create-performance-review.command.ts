import { ReviewPeriodType } from '../entities/performance-review.entity';

export class CreatePerformanceReviewCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly reviewerId: string,
    public readonly periodType: ReviewPeriodType,
    public readonly periodStart: string,
    public readonly periodEnd: string,
  ) {}
}
