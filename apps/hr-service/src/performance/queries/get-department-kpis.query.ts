export class GetDepartmentKPIsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId: string,
    public readonly periodStart: string,
    public readonly periodEnd: string,
  ) {}
}
