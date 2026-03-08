export class GetDailyAttendanceOverviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly date?: string,
  ) {}
}
