export class ConfirmSafetyTrainingAttendanceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly recordId: string,
    public readonly userId: string,
  ) {}
}
