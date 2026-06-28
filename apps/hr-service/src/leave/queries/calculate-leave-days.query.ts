export class CalculateLeaveDaysQuery {
  constructor(
    public readonly tenantId: string,
    public readonly leaveTypeId: string,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly isHalfDayStart = false,
    public readonly isHalfDayEnd = false,
  ) {}
}
