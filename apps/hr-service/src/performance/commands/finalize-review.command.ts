export class FinalizeReviewCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly reviewId: string,
    public readonly finalRating: number,
    public readonly calibrationNotes?: string,
    public readonly reviewerComments?: string,
  ) {}
}
