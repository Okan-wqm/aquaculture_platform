export class GetTeamGoalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly managerId: string,
    public readonly status?: string,
  ) {}
}
