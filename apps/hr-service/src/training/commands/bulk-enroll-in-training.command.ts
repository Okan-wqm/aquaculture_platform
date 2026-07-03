export class BulkEnrollInTrainingCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly courseId: string,
    public readonly employeeIds: string[],
  ) {}
}
