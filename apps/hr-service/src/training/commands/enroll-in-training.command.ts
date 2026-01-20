export class EnrollInTrainingCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly trainingCourseId: string,
    public readonly dueDate?: string,
    public readonly sessionId?: string,
    public readonly instructor?: string,
    public readonly location?: string,
  ) {}
}
