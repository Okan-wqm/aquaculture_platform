export class GetPerformanceReviewsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly status?: string,
    public readonly limit?: number,
    public readonly offset?: number,
  ) {}
}
