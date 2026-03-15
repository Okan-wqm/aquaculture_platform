export class ReopenReviewCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly reviewId: string,
    public readonly reason: string,
  ) {}
}
