export class GetRotationCalendarQuery {
  constructor(
    public readonly tenantId: string,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly workAreaId?: string,
  ) {}
}
