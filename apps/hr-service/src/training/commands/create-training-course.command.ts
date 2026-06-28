import { CreateTrainingCourseInput } from '../dto/create-training-course.input';

export class CreateTrainingCourseCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly input: CreateTrainingCourseInput,
  ) {}
}
