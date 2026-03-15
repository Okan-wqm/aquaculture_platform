export class GetPerformanceReviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
