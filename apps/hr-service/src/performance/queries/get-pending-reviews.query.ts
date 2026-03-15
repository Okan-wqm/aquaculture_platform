export class GetPendingReviewsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly reviewerId: string,
  ) {}
}
