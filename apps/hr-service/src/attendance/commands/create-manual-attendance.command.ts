export class CreateManualAttendanceCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly date: string,
    public readonly clockIn?: string,
    public readonly clockOut?: string,
    public readonly reason: string = '',
    public readonly shiftId?: string,
  ) {}
}
