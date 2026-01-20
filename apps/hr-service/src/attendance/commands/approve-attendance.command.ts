export class ApproveAttendanceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly attendanceRecordId: string,
    public readonly notes?: string,
  ) {}
}
