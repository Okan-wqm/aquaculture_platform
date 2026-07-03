export class GetTrainingCourseQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
