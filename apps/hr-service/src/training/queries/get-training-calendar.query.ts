export class GetTrainingCalendarQuery {
  constructor(
    public readonly tenantId: string,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly courseId?: string,
    public readonly workAreaId?: string,
  ) {}
}
