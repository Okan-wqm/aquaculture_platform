export class GetUpcomingRotationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly limit: number = 5,
  ) {}
}
