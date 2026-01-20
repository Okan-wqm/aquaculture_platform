export class CompleteTrainingCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly enrollmentId: string,
    public readonly score?: number,
    public readonly feedback?: string,
    public readonly feedbackRating?: number,
  ) {}
}
