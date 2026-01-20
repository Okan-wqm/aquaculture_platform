export class GetEmployeeQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
  ) {}
}
