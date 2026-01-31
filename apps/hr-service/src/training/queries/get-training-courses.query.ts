import { TrainingType } from '../entities/training-course.entity';

export class GetTrainingCoursesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly trainingType?: TrainingType,
    public readonly isMandatory?: boolean,
    public readonly isActive?: boolean,
    public readonly limit: number = 20,
    public readonly offset: number = 0,
  ) {}
}
