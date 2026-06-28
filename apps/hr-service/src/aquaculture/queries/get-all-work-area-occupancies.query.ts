export class GetAllWorkAreaOccupanciesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly date: string,
  ) {}
}
