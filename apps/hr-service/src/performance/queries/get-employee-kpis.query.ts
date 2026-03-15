export class GetEmployeeKPIsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly periodStart?: string,
    public readonly periodEnd?: string,
  ) {}
}
