export class GetOverdueGoalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId?: string,
  ) {}
}
