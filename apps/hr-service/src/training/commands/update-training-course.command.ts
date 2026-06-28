import { UpdateTrainingCourseInput } from '../dto/update-training-course.input';

export class UpdateTrainingCourseCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: UpdateTrainingCourseInput,
  ) {}
}
