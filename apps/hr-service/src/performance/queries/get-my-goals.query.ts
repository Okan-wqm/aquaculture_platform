export class GetMyGoalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly status?: string,
  ) {}
}
