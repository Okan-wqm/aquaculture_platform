export class GetMyPerformanceReviewsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly status?: string,
  ) {}
}
