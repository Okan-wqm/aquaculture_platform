import { CompetencyRatingInput } from '../dto/submit-self-assessment.input';

export class SubmitSelfAssessmentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly reviewId: string,
    public readonly selfAssessment: string,
    public readonly selfRating: number,
    public readonly competencyRatings?: CompetencyRatingInput[],
  ) {}
}
