import { CompetencyRatingInput } from '../dto/submit-self-assessment.input';

export class SubmitManagerAssessmentCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly reviewId: string,
    public readonly managerAssessment: string,
    public readonly managerRating: number,
    public readonly competencyRatings?: CompetencyRatingInput[],
    public readonly strengths?: string[],
    public readonly areasForImprovement?: string[],
    public readonly developmentPlan?: string,
  ) {}
}
