export class GetWorkAreaOccupancyQuery {
  constructor(
    public readonly tenantId: string,
    public readonly workAreaId: string,
    public readonly date: string,
  ) {}
}
