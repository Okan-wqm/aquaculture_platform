export class GetAttendanceSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly month: number,
    public readonly year: number,
  ) {}
}
